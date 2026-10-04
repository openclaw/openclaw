import { beforeEach, expect, it, vi } from "vitest";

const materialize = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/mcp-app-channel-action.js", () => ({
  materializeMcpAppChannelPresentation: materialize,
}));

import { renderMessagePresentationFallbackText } from "../../interactive/payload.js";
import type { ReplyPayload } from "../types.js";
import { attachMcpAppChannelAction, attachMcpConnectChannelAction } from "./mcp-channel-actions.js";

const view = { viewId: "view-latest" };
const connectAction = {
  serverName: "calendar",
  authorizationUrl: "https://auth.example/authorize?state=opaque",
};
const presentation = {
  blocks: [
    {
      type: "buttons" as const,
      buttons: [
        {
          label: "Open app",
          action: {
            type: "web-app" as const,
            url: "https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
          },
        },
      ],
    },
  ],
};

beforeEach(() => {
  materialize.mockReset();
  materialize.mockReturnValue(presentation);
});

function attachApp(payloads: ReplyPayload[], channel: string | undefined) {
  return attachMcpAppChannelAction({ payloads, channel, sessionKey: "agent:main:main", view });
}

it.each([
  [
    "app",
    "Final answer",
    "Open app: https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
  ],
  [
    "connect",
    "Sign in to continue.",
    "Connect calendar: https://auth.example/authorize?state=opaque",
  ],
])("attaches one %s action to the final visible reply", (kind, text, fallback) => {
  const input = [{ text: "progress", isStatusNotice: true }, { text: "First answer" }, { text }];
  const payloads =
    kind === "app"
      ? attachApp(input, "telegram")
      : attachMcpConnectChannelAction({ payloads: input, action: connectAction });
  expect(payloads[1]).toEqual({ text: "First answer" });
  if (kind === "app") {
    expect(payloads[2]).toEqual({ text, presentation });
  }
  expect(renderMessagePresentationFallbackText(payloads[2]!)).toBe(`${text}\n\n- ${fallback}`);
});

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
    ["no connect action", error, (payloads) => attachMcpConnectChannelAction({ payloads })],
    [
      "connect error",
      error,
      (payloads) => attachMcpConnectChannelAction({ payloads, action: connectAction }),
    ],
    [
      "late materialization unavailable",
      visible,
      (payloads) => attachApp(payloads, "telegram"),
      true,
    ],
  ];
  for (const [name, payloads, attach, materializationUnavailable] of cases) {
    materialize.mockReset();
    materialize.mockReturnValue(materializationUnavailable ? undefined : presentation);
    expect(attach(payloads), name).toBe(payloads);
    if (!materializationUnavailable) {
      expect(materialize, name).not.toHaveBeenCalled();
    }
  }
});
