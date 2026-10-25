import { beforeEach, expect, it, vi } from "vitest";

const materialize = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/mcp-app-channel-action.js", () => ({
  materializeMcpAppChannelPresentation: materialize,
}));

import { renderMessagePresentationFallbackText as renderFallback } from "../../interactive/payload.js";
import {
  isReplyPayloadSessionWriterDeliveryAuthorized as isAuthorized,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import {
  attachMcpAppChannelAction,
  attachMcpConnectChannelAction as attachConnect,
} from "./mcp-channel-actions.js";

const view = { viewId: "view-latest" };
const appUrl = "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket";
const authUrl = "https://auth.example/authorize?state=opaque";
const action = { serverName: "calendar", authorizationUrl: authUrl };
const presentation = {
  blocks: [
    {
      type: "buttons" as const,
      buttons: [{ label: "Open app", action: { type: "web-app" as const, url: appUrl } }],
    },
  ],
};

beforeEach(() => {
  materialize.mockReset().mockReturnValue(presentation);
});

function attachApp(payloads: ReplyPayload[], channel: string | undefined) {
  return attachMcpAppChannelAction({ payloads, channel, sessionKey: "agent:main:main", view });
}

it.each([
  ["app", "Final answer", `Open app: ${appUrl}`],
  ["connect", "Sign in to continue.", `Connect calendar: ${authUrl}`],
])(
  "attaches one %s action while preserving final reply writer authority",
  (kind, text, fallback) => {
    const finalReply = setReplyPayloadMetadata(
      { text },
      {
        sessionWriterDeliveryAuthority: {
          sessionKey: "agent:main:main",
          expectedSessionId: "session-original",
          expectedWriterRunId: "writer-original",
        },
      },
    );
    const input = [
      { text: "progress", isStatusNotice: true },
      { text: "First answer" },
      finalReply,
    ];
    const payloads =
      kind === "app" ? attachApp(input, "telegram") : attachConnect({ payloads: input, action });
    expect(payloads[1]).toEqual({ text: "First answer" });
    if (kind === "app") {
      expect(payloads[2]).toEqual({ text, presentation });
    }
    expect(renderFallback(payloads[2]!)).toBe(`${text}\n\n- ${fallback}`);
    expect(
      ["writer-original", "writer-replacement"].map((activeWriterRunId) =>
        isAuthorized(payloads[2]!, { sessionId: "session-original", activeWriterRunId }),
      ),
    ).toEqual([true, false]);
  },
);

it("preserves payloads when no channel action can be attached", () => {
  const visible = [{ text: "Final answer" }];
  const error = [{ text: "failed", isError: true }];
  const ineligible = [
    { text: "status", isStatusNotice: true },
    { text: "error", isError: true },
    { mediaUrl: "https://example.test/image.png" },
  ];
  const cases: Array<
    [string, ReplyPayload[], (payloads: ReplyPayload[]) => ReplyPayload[], boolean?]
  > = [
    ["Control UI", visible, (payloads) => attachApp(payloads, "webchat")],
    ["unresolved channel", visible, (payloads) => attachApp(payloads, undefined)],
    ["no terminal text", ineligible, (payloads) => attachApp(payloads, "telegram")],
    ["no connect action", error, (payloads) => attachConnect({ payloads })],
    ["connect error", error, (payloads) => attachConnect({ payloads, action })],
    ["unavailable", visible, (payloads) => attachApp(payloads, "telegram"), true],
  ];
  for (const [name, payloads, attach, unavailable] of cases) {
    materialize.mockReset().mockReturnValue(unavailable ? undefined : presentation);
    expect(attach(payloads), name).toBe(payloads);
    if (!unavailable) {
      expect(materialize, name).not.toHaveBeenCalled();
    }
  }
});
