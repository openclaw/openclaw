import { expect, it, vi } from "vitest";
import { createTestAdmittedRunContext } from "../../agents/admitted-run-context.test-support.js";
import { createCronTool } from "../../agents/tools/cron-tool.js";
import {
  getGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "../../agents/tools/gateway-caller-context.js";
import * as gatewayModule from "../../agents/tools/gateway.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import {
  claimAgentRunDelegatedAuthority,
  releaseAgentRunDelegatedAuthority,
} from "../../infra/agent-run-registry.js";
import { bindCommandOwnerAuthority } from "../command-owner-authority.js";
import { runReplyAgent } from "./agent-runner-run.js";
import type { runPreparedReply } from "./get-reply-run.js";
import { createOwnerIngress } from "./get-reply-run.owner-ingress.test-support.js";

type ReplyParams = Parameters<typeof runPreparedReply>[0];
export function registerTelegramRequesterAuthorityCases(
  runPrepared: (overrides?: Partial<ReplyParams>) => ReturnType<typeof runPreparedReply>,
) {
  it.each([
    "owner",
    "no capability",
    "no bound identity",
    "revoked",
    "other account",
    "other sender",
  ] as const)(
    "requires the matching live host-bound Telegram owner at reply entry: %s",
    async (kind) => {
      const runId = "telegram-owner-capture";
      const params = createOwnerIngress(
        "telegram-named-account",
        "telegram",
        "list automations",
        runId,
      );
      const principal = { channelId: "telegram", accountId: "work", senderId: "owner-1" };
      if (kind !== "no capability") {
        bindCommandOwnerAuthority(params.sessionCtx, {
          channelPrincipal: kind === "no bound identity" ? undefined : principal,
          isCurrent: () => kind !== "revoked",
        });
      }
      // Even a configured owner flag and matching raw fields do not authenticate ingress.
      if (kind === "other account") {
        params.ctx.AccountId = params.sessionCtx.AccountId = "other";
      }
      if (kind === "other sender") {
        params.ctx.SenderId = params.sessionCtx.SenderId = "other-owner";
      }
      const cfg = { commands: { ownerAllowFrom: ["telegram:owner-1", "telegram:other-owner"] } };
      setRuntimeConfigSnapshot(cfg);
      const { operationalRunInstance } = createTestAdmittedRunContext(runId);
      const authority = claimAgentRunDelegatedAuthority(operationalRunInstance);
      let observed = false;
      vi.mocked(runReplyAgent).mockImplementationOnce(async ({ opts }) => {
        expect(Boolean(opts?.cronCreatorAuthorityCapability)).toBe(kind === "owner");
        await withGatewayToolCallerIdentity(
          {
            agentId: "default",
            sessionKey: "session-key",
            operationalRunInstance,
            approvalAuthority: authority,
          },
          async () => {
            using _ = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(async <T>() => {
              expect(Boolean(getGatewayToolCallerIdentity()?.cronManagementGrant)).toBe(
                kind === "owner",
              );
              observed = true;
              return { jobs: [], total: 0, hasMore: false } as T;
            });
            await createCronTool({ runId, agentSessionKey: "session-key" }).execute("list", {
              action: "list",
            });
          },
        );
        return undefined;
      });
      try {
        await runPrepared({ ...params, cfg });
        expect(observed).toBe(true);
      } finally {
        releaseAgentRunDelegatedAuthority(authority);
        clearRuntimeConfigSnapshot();
      }
    },
  );
}
