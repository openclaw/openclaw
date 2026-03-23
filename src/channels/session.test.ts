import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

const recordSessionMetaFromInboundMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));
const updateLastRouteMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));

vi.mock("../config/sessions.js", () => ({
  recordSessionMetaFromInbound: (args: unknown) => recordSessionMetaFromInboundMock(args),
  updateLastRoute: (args: unknown) => updateLastRouteMock(args),
}));

type SessionModule = typeof import("./session.js");

let recordInboundSession: SessionModule["recordInboundSession"];

describe("recordInboundSession", () => {
  const ctx: MsgContext = {
    Provider: "telegram",
    From: "telegram:1234",
    SessionKey: "agent:main:telegram:1234:thread:42",
    OriginatingTo: "telegram:1234",
  };

  beforeEach(async () => {
    vi.resetModules();
    ({ recordInboundSession } = await import("./session.js"));
    recordSessionMetaFromInboundMock.mockClear();
    updateLastRouteMock.mockClear();
  });

  it("does not pass ctx when updating a different session key", async () => {
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

  it("normalizes mixed-case session keys before recording and route updates", async () => {
    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "Agent:Main:Telegram:1234:Thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:telegram:1234:thread:42",
        channel: "telegram",
        to: "telegram:1234",
      },
      onRecordError: vi.fn(),
    });

    expect(recordSessionMetaFromInboundMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:1234:thread:42",
      }),
    );
    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:telegram:1234:thread:42",
        ctx,
      }),
    );
  });

  it("skips last-route updates when main DM owner pin mismatches sender", async () => {
    const onSkip = vi.fn();

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:telegram:1234:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "telegram",
        to: "telegram:1234",
        mainDmOwnerPin: {
          ownerRecipient: "1234",
          senderRecipient: "9999",
          onSkip,
        },
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).not.toHaveBeenCalled();
    expect(onSkip).toHaveBeenCalledWith({
      ownerRecipient: "1234",
      senderRecipient: "9999",
    });
  });
});
