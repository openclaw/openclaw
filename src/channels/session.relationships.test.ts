import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MsgContext } from "../auto-reply/templating.js";

const recordSessionMetaFromInboundMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));
const updateLastRouteMock = vi.fn((_args?: unknown) => Promise.resolve(undefined));

vi.mock("../config/sessions.js", () => ({
  recordSessionMetaFromInbound: (args: unknown) => recordSessionMetaFromInboundMock(args),
  updateLastRoute: (args: unknown) => updateLastRouteMock(args),
}));

function withRelationshipHints(ctx: MsgContext, hints: Record<string, unknown>): MsgContext {
  return {
    ...ctx,
    ...hints,
  };
}

describe("recordInboundSession relationship metadata isolation", () => {
  const baseCtx: MsgContext = {
    Provider: "slack",
    From: "user:U123",
    SessionKey: "agent:main:slack:user:u123:thread:42",
    OriginatingTo: "channel:C123",
  };

  beforeEach(() => {
    recordSessionMetaFromInboundMock.mockClear();
    updateLastRouteMock.mockClear();
  });

  it("does not forward relationship-bearing ctx to a different target session", async () => {
    const { recordInboundSession } = await import("./session.js");

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:slack:user:u123:thread:42",
      ctx: withRelationshipHints(baseCtx, {
        IncidentId: "incident:123",
        EntityRefs: ["entity:thread:42"],
      }),
      updateLastRoute: {
        sessionKey: "agent:main:main",
        channel: "slack",
        to: "channel:C123",
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:main",
        ctx: undefined,
      }),
    );
  });

  it("keeps relationship-bearing ctx on same-session route updates", async () => {
    const { recordInboundSession } = await import("./session.js");
    const ctx = withRelationshipHints(baseCtx, {
      IncidentId: "incident:123",
      ThreadEntityId: "entity:thread:42",
    });

    await recordInboundSession({
      storePath: "/tmp/openclaw-session-store.json",
      sessionKey: "agent:main:slack:user:u123:thread:42",
      ctx,
      updateLastRoute: {
        sessionKey: "agent:main:slack:user:u123:thread:42",
        channel: "slack",
        to: "channel:C123",
      },
      onRecordError: vi.fn(),
    });

    expect(updateLastRouteMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: "agent:main:slack:user:u123:thread:42",
        ctx,
      }),
    );
  });
});
