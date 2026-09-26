import { beforeEach, describe, expect, it, vi } from "vitest";

const materialize = vi.hoisted(() => vi.fn());
vi.mock("../../gateway/mcp-app-channel-action.js", () => ({
  materializeMcpAppChannelPresentation: materialize,
}));

import { renderMessagePresentationFallbackText } from "../../interactive/payload.js";
import { attachMcpAppChannelAction, attachMcpConnectChannelAction } from "./mcp-channel-actions.js";

const view = { viewId: "view-latest" };
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

describe("attachMcpAppChannelAction", () => {
  it("attaches one action to the latest visible reply and preserves original text", () => {
    const payloads = attachMcpAppChannelAction({
      payloads: [
        { text: "progress", isStatusNotice: true },
        { text: "First answer" },
        { text: "Final answer" },
      ],
      channel: "telegram",
      sessionKey: "agent:main:main",
      view,
    });

    expect(payloads[1]).toEqual({ text: "First answer" });
    const finalPayload = payloads[2];
    expect(finalPayload).toEqual({ text: "Final answer", presentation });
    if (!finalPayload) {
      throw new Error("expected final payload");
    }
    expect(renderMessagePresentationFallbackText(finalPayload)).toBe(
      "Final answer\n\n- Open app: https://node.tailnet.ts.net/__openclaw__/mcp-app#opaque-ticket",
    );
  });

  it("keeps Control UI inline-only without minting a duplicate action", () => {
    const payloads = [{ text: "Final answer" }];

    expect(
      attachMcpAppChannelAction({
        payloads,
        channel: "webchat",
        sessionKey: "agent:main:main",
        view,
      }),
    ).toBe(payloads);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("does not mint without a resolved channel transport", () => {
    const payloads = [{ text: "Final answer" }];

    expect(
      attachMcpAppChannelAction({
        payloads,
        sessionKey: "agent:main:main",
        view,
      }),
    ).toBe(payloads);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("preserves the original payloads when late materialization is unavailable", () => {
    materialize.mockReturnValue(undefined);
    const payloads = [{ text: "Final answer" }];

    expect(
      attachMcpAppChannelAction({
        payloads,
        channel: "telegram",
        sessionKey: "agent:main:main",
        view,
      }),
    ).toBe(payloads);
  });

  it("does not mint for status, error, or non-text terminal payloads", () => {
    const payloads = [
      { text: "status", isStatusNotice: true },
      { text: "error", isError: true },
      { mediaUrl: "https://example.test/image.png" },
    ];

    expect(
      attachMcpAppChannelAction({
        payloads,
        channel: "telegram",
        sessionKey: "agent:main:main",
        view,
      }),
    ).toBe(payloads);
    expect(materialize).not.toHaveBeenCalled();
  });
});

describe("attachMcpConnectChannelAction", () => {
  it("adds one portable URL action to the final visible reply", () => {
    const payloads = attachMcpConnectChannelAction({
      payloads: [{ text: "progress", isStatusNotice: true }, { text: "Sign in to continue." }],
      action: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/authorize?state=opaque",
      },
    });

    expect(renderMessagePresentationFallbackText(payloads[1]!)).toBe(
      "Sign in to continue.\n\n- Connect calendar: https://auth.example/authorize?state=opaque",
    );
  });

  it("preserves payloads without an action or eligible terminal reply", () => {
    const payloads = [{ text: "failed", isError: true }];
    expect(attachMcpConnectChannelAction({ payloads })).toBe(payloads);
    expect(
      attachMcpConnectChannelAction({
        payloads,
        action: { serverName: "calendar", authorizationUrl: "https://auth.example/authorize" },
      }),
    ).toBe(payloads);
  });
});
