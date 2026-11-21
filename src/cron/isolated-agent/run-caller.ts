import { resolveGroupToolPolicy } from "../../agents/agent-tools.policy.js";
import { resolveScheduledToolCallerContext } from "../../agents/scheduled-tool-policy.js";
import { resolveCronJobToolPolicyContext } from "../execution-context-admission.js";
import type { MintedScheduledExecution } from "../scheduled-occurrence.js";
import type { CronRunExecutionParams } from "./run-execution.types.js";

export function prepareCronCaller(
  params: Pick<
    CronRunExecutionParams,
    | "occurrence"
    | "job"
    | "agentPayload"
    | "operatorAuthority"
    | "sourceDelivery"
    | "resolvedDelivery"
    | "cfgWithAgentDefaults"
  >,
) {
  const personal = params.occurrence.personalRequester;
  const scheduledToolPolicy = resolveCronJobToolPolicyContext(
    params.job,
    params.agentPayload?.toolsAllow,
  );
  if (personal) {
    if (
      scheduledToolPolicy?.mode !== "account" ||
      scheduledToolPolicy.ownerAccountId !== personal.accountId ||
      params.operatorAuthority
    ) {
      throw new Error("Personal task requires its originating account.");
    }
    scheduledToolPolicy.personalRequester = personal;
  }
  const { sourceDelivery } = params;
  const messageChannel = personal
    ? "whatsapp"
    : (sourceDelivery.target.channel ?? params.resolvedDelivery.channel);
  if (scheduledToolPolicy?.mode === "account") {
    const callerContext = resolveScheduledToolCallerContext({ scheduledToolPolicy });
    resolveGroupToolPolicy({
      config: params.cfgWithAgentDefaults,
      sessionKey: scheduledToolPolicy.ownerSessionKey,
      messageProvider: callerContext.local ? messageChannel : (callerContext.channel ?? undefined),
      accountId: scheduledToolPolicy.ownerAccountId,
      requireConfiguredAccount: true,
      senderId: personal?.senderId,
      senderE164: personal?.senderId,
      senderPolicyMode: personal ? "always" : "never",
    });
  }
  if (!personal || scheduledToolPolicy?.mode !== "account") {
    return { messageChannel, scheduledToolPolicy };
  }
  const sessionKey = scheduledToolPolicy.ownerSessionKey;
  return {
    messageChannel,
    scheduledToolPolicy,
    personal: {
      runParams: {
        agentAccountId: personal.accountId,
        senderId: personal.senderId,
        senderE164: personal.senderId,
        senderIsOwner: false,
        chatType: "direct" as const,
        conversationId: personal.senderId,
        requesterOrigin: {
          sessionKey,
          messageProvider: "whatsapp" as const,
          accountId: personal.accountId,
          senderId: personal.senderId,
          senderE164: personal.senderId,
          chatType: "direct" as const,
          conversationId: personal.senderId,
        },
        toolOverrides: params.occurrence.parentPermissions?.toolOverrides,
        permissionMode: params.occurrence.parentPermissions?.permissionMode,
        sessionRoot: params.occurrence.parentPermissions?.sessionRoot,
      },
      requireParent(scheduledExecution: MintedScheduledExecution) {
        if (
          scheduledExecution.result.status !== "ready" ||
          scheduledExecution.result.facts.authority.owner ||
          scheduledExecution.result.facts.principal.kind !== "parent" ||
          !params.occurrence.parentPermissions ||
          scheduledExecution.result.facts.principal.parent.sessionKey !== sessionKey ||
          scheduledExecution.result.facts.principal.parent.agentId !== params.job.agentId
        ) {
          scheduledExecution.release();
          throw new Error("Personal task requires an admitted non-owner conversation.");
        }
      },
      assertCurrent() {
        personal.assertCurrent();
        params.occurrence.childParent?.assertCurrent();
        params.occurrence.parentPermissions?.assertCurrent();
      },
      checkRuntime(embedded: boolean, provider: string) {
        if (!embedded) {
          throw new Error("Personal tasks require the OpenClaw runtime.");
        }
        if (params.job.inferenceBinding && params.job.inferenceBinding.provider !== provider) {
          throw new Error("Personal task requires its recorded inference account.");
        }
        personal.assertCurrent();
      },
    },
  };
}
