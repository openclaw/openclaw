// Tests runtime-loaded fast-path command behavior for get-reply.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { classifyTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import type { MsgContext } from "../templating.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();
const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-getreply-fast-" });

installReplyRuntimeMocks(agentMocks);

function makeLineReplyContext(senderId: string): MsgContext {
  return {
    Body: "hello",
    BodyForAgent: "hello",
    RawBody: "hello",
    CommandBody: "hello",
    From: `line:${senderId}`,
    To: `line:${senderId}`,
    SenderId: senderId,
    AccountId: "default",
    SessionKey: `agent:main:line:${senderId}`,
    Provider: "line",
    Surface: "line",
    OriginatingChannel: "line",
    OriginatingTo: `line:${senderId}`,
    ChatType: "direct",
    InboundAccessAuthorized: false,
    CommandAuthorized: false,
  };
}

function requireIssuedTurnAuthority(ctx: MsgContext) {
  const authority = classifyTurnAuthoritySnapshot(ctx.TurnAuthority);
  if (authority.kind !== "issued") {
    throw new Error("expected issued turn authority");
  }
  return authority.snapshot;
}

describe("getReplyFromConfig fast-path runtime", () => {
  beforeAll(async () => {
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
    agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("warm runtime"));
    await withTempHome(async (home) => {
      await getReplyFromConfig(
        {
          Body: "warm runtime",
          BodyForAgent: "warm runtime",
          RawBody: "warm runtime",
          CommandBody: "warm runtime",
          From: "+1001",
          To: "+2000",
          SessionKey: "agent:main:whatsapp:+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );
    });
    vi.unstubAllEnvs();
  });

  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps old-style runtime tests fast with marked temp-home configs", async () => {
    await withTempHome(async (home) => {
      let seenPrompt: string | undefined;
      agentMocks.runEmbeddedAgent.mockImplementation(async (params) => {
        seenPrompt = params.prompt;
        return makeEmbeddedTextResult("ok");
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "+1001",
          To: "+2000",
          MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
          MediaUrls: ["/tmp/a.png", "/tmp/b.png"],
          SessionKey: "agent:main:whatsapp:+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(seenPrompt).toContain("[media attached: 2 files]");
      expect(seenPrompt).toContain("hello");
    });
  });

  it("preserves LINE sender identity authorized through commands.allowFrom", async () => {
    await withTempHome(async (home) => {
      const senderId = "U1234567890abcdef1234567890abcdef";
      const ctx = makeLineReplyContext(senderId);
      const cfg = makeReplyConfig(home) as OpenClawConfig;
      cfg.commands = { allowFrom: { line: [senderId] } };
      agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(ctx, {}, cfg);

      const authority = requireIssuedTurnAuthority(ctx);
      expect(authority.authorization.principal).toEqual({
        kind: "sender",
        provider: "line",
        accountId: "default",
        senderId,
        senderIsOwner: false,
        isAuthorizedSender: true,
      });
      expect(authority.controllerKey).toBe(`sender:line:default:${senderId}`);
    });
  });

  it("does not preserve unmatched LINE sender identity from commands.allowFrom", async () => {
    await withTempHome(async (home) => {
      const senderId = "U00000000000000000000000000000000";
      const ctx = makeLineReplyContext(senderId);
      const cfg = makeReplyConfig(home) as OpenClawConfig;
      cfg.commands = {
        allowFrom: { line: ["U1234567890abcdef1234567890abcdef"] },
      };
      agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(ctx, {}, cfg);

      const authority = requireIssuedTurnAuthority(ctx);
      expect(authority.authorization.principal).toEqual({
        kind: "unknown",
        provider: "line",
        accountId: "default",
      });
      expect(authority.controllerKey).toBeUndefined();
    });
  });

  it("routes structured native command turns through the target session before legacy sync", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          CommandTurn: {
            kind: "native",
            source: "native",
            authorized: true,
          },
          CommandTargetSessionKey: "agent:main:telegram:direct:target",
          SessionKey: "telegram:slash:source",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:target",
        }),
      );
    });
  });

  it("ignores stale native legacy source for structured normal turns before routing", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

      await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          CommandSource: "native",
          CommandTurn: {
            kind: "normal",
            source: "message",
            authorized: false,
          },
          CommandTargetSessionKey: "agent:main:telegram:direct:stale-target",
          SessionKey: "agent:main:telegram:direct:source",
          Provider: "telegram",
          Surface: "telegram",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:telegram:direct:source",
        }),
      );
    });
  });
});
