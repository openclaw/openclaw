import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

const recordSessionMetaFromInboundMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));
const updateLastRouteMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));

vi.mock("../config/sessions.js", () => ({
  recordSessionMetaFromInbound: (args: unknown) => recordSessionMetaFromInboundMock(args),
  updateLastRoute: (args: unknown) => updateLastRouteMock(args),
}));

describe("recordInboundSession", () => {
  const ctx: MsgContext = {
    Provider: "telegram",
    From: "telegram:1234",
    SessionKey: "agent:main:telegram:1234:thread:42",
    OriginatingTo: "telegram:1234",
  };

  beforeEach(() => {
    recordSessionMetaFromInboundMock.mockClear();
    updateLastRouteMock.mockClear();
  });

  it("does not pass ctx when updating a different session key", async () => {
    const { recordInboundSession } = await import("./session.js");

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:telegram:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "telegram",
        to: "telegram:1234",
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        ctx: undefined,
        deliveryContext: expect.objectContaining({
          channel: "telegram",
          to: "telegram:1234",
        }),
      }),
    );
  });

  it("passes ctx when updating the same session key", async () => {
    const { recordInboundSession } = await import("./session.js");

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:telegram:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:telegram:1234:thread:42",
        channel: "telegram",
        to: "telegram:1234",
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:1234:thread:42",
        ctx,
        deliveryContext: expect.objectContaining({
          channel: "telegram",
          to: "telegram:1234",
        }),
      }),
    );
  });
});
