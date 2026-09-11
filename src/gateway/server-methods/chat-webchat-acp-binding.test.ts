import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { bindSpawnedAcpSession } from "../../auto-reply/reply/commands-acp/bindings.js";
import { handleSessionCommand } from "../../auto-reply/reply/commands-session.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import { resolveBoundAcpDispatchSessionKey } from "../../auto-reply/reply/dispatch-from-config.context.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { getSessionBindingService } from "../../infra/outbound/session-binding-service.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { resolveChatSendOriginatingRoute } from "./chat-origin-routing.js";

const sessionKey = "agent:main:dashboard:11111111-1111-4111-8111-111111111111";
const targetSessionKey = "agent:claude:acp:22222222-2222-4222-8222-222222222222";
const cfg = { session: { threadBindings: { enabled: true } } };

function webchatContext(key = sessionKey, deliver = false) {
  const origin = resolveChatSendOriginatingRoute({
    sessionKey: key,
    client: { id: "openclaw-control-ui", mode: "webchat" },
    deliver,
    entry: { delivery: { kind: "internal" } },
  });
  return finalizeInboundContext({
    SessionKey: key,
    Provider: "webchat",
    Surface: "webchat",
    OriginatingChannel: origin.originatingChannel,
    OriginatingTo: origin.originatingTo,
    AccountId: origin.accountId,
    GatewayClientScopes: ["operator.admin"],
  });
}

describe("dashboard WebChat ACP binding", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeEach(() => {
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-webchat-acp-"));
  });
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it.each([false, true])(
    "binds an internal dashboard with deliver=%s, survives reopen, and detaches independently",
    async (deliver) => {
      const commandParams = buildCommandTestParams(
        "/acp spawn claude --bind here",
        cfg,
        webchatContext(sessionKey, deliver),
      );
      commandParams.sessionKey = sessionKey;
      const result = await bindSpawnedAcpSession({
        commandParams,
        sessionKey: targetSessionKey,
        agentId: "claude",
        mode: "conversation",
      });
      expect(result, JSON.stringify(result)).toMatchObject({
        ok: true,
        bound: {
          binding: {
            conversation: { channel: "webchat", accountId: "default", conversationId: sessionKey },
          },
        },
      });
      closeOpenClawStateDatabaseForTest();
      expect(resolveBoundAcpDispatchSessionKey({ cfg, ctx: webchatContext() })).toBe(
        targetSessionKey,
      );
      expect(
        resolveBoundAcpDispatchSessionKey({
          cfg,
          ctx: webchatContext(sessionKey.replace("main", "other")),
        }),
      ).toBeUndefined();
      expect(
        resolveBoundAcpDispatchSessionKey({
          cfg,
          ctx: webchatContext(sessionKey.replace("11111111", "33333333")),
        }),
      ).toBeUndefined();
      const siblingKey = sessionKey.replace("11111111", "44444444");
      await getSessionBindingService().bind({
        targetSessionKey,
        targetKind: "session",
        placement: "current",
        conversation: { channel: "webchat", accountId: "default", conversationId: siblingKey },
      });
      expect(
        resolveBoundAcpDispatchSessionKey({
          cfg,
          ctx: { ...webchatContext(), AccountId: "other" },
        }),
      ).toBeUndefined();
      const unbindParams = buildCommandTestParams("/session unbind", cfg, webchatContext());
      unbindParams.sessionKey = sessionKey;
      const unbound = await handleSessionCommand(unbindParams, true);
      expect(unbound?.reply?.text).toContain("Conversation unbound.");
      expect(resolveBoundAcpDispatchSessionKey({ cfg, ctx: webchatContext(siblingKey) })).toBe(
        targetSessionKey,
      );
      expect(resolveBoundAcpDispatchSessionKey({ cfg, ctx: webchatContext() })).toBeUndefined();
    },
  );
});
