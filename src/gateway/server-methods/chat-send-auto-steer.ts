import { performance } from "node:perf_hooks";
import type { AutoSteerReceipt } from "../../../packages/gateway-protocol/src/schema/logs-chat.js";
import { assertOperatorModelAllowed } from "../../agents/admitted-run-context.js";
import { isDecisionAssistanceEligible } from "../../agents/decision-assistance.js";
import { resolveDecisionModelSetting } from "../../agents/decision-model-setting.js";
import { normalizeModelRef } from "../../agents/model-ref-shared.js";
import { resolveQueueSettingsCore } from "../../auto-reply/reply/queue/settings.js";
import { replyRunRegistry } from "../../auto-reply/reply/reply-run-registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../../infra/abort-signal.js";
import { getProcessGatewayPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../utils/message-channel.js";
import type { AdmittedChatSend } from "./chat-send-admission.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import type { PreparedChatSendSession } from "./chat-send-session.js";
import type { GatewayClient } from "./shared-types.js";

const DEADLINE_MS = 500;
export const AUTO_STEER_MAX_INPUT_CHARS = 8_000;

/** All non-command human inputs share admission order, whether or not inference may inspect them. */
export function isHumanControlUiInput(
  request: NormalizedChatSendRequest,
  client: GatewayClient | null,
): boolean {
  return (
    client?.connect.client.id === "openclaw-control-ui" &&
    client.connect.role === "operator" &&
    !client.internal?.syntheticClient &&
    !request.systemInputProvenance &&
    !request.systemProvenanceReceipt &&
    !request.suppressCommandInterpretation &&
    !request.explicitOrigin &&
    !request.reconnectResumeRequested &&
    !request.goalOperation &&
    !request.providerReviewAcknowledgment &&
    !request.stopCommand &&
    request.turnKind === "main" &&
    !/^[\s]*[!/]/u.test(request.rawMessage)
  );
}

/** Only plain text, without attached context, may cross into automatic classification. */
export function isOrdinaryControlUiInput(
  request: NormalizedChatSendRequest,
  client: GatewayClient | null,
): boolean {
  return (
    isHumanControlUiInput(request, client) &&
    !request.workContext &&
    !request.p.replyToId &&
    !request.normalizedAttachments.length &&
    Boolean(request.rawMessage.trim())
  );
}

type RoutingParams = {
  request: NormalizedChatSendRequest;
  session: PreparedChatSendSession;
  admission: AdmittedChatSend;
  client: GatewayClient | null;
  assertCurrent: () => void;
  getConfig: () => OpenClawConfig;
};

class AdviceNoLongerEligible extends Error {}

/**
 * Own the whole optional-work deadline. A logical timeout does not dispose the
 * Decision provider: its existing owner retains physical inference until settlement.
 */
async function resolveAutoRoute(
  params: RoutingParams,
  baselineMode: NormalizedChatSendRequest["resolvedQueueMode"],
): Promise<{
  receipt?: AutoSteerReceipt;
  deadlineMonotonicMs?: number;
  stillEligible: () => boolean;
}> {
  const { request, session, admission } = params;
  if (
    request.p.deliveryPolicy !== "auto" ||
    baselineMode === "interrupt" ||
    request.rawMessage.length > AUTO_STEER_MAX_INPUT_CHARS ||
    request.p.queueMode === "collect" ||
    !isOrdinaryControlUiInput(request, params.client)
  ) {
    return { stillEligible: () => false };
  }
  const initialConfig = params.getConfig();
  if (
    !isDecisionAssistanceEligible(initialConfig, session.agentId) ||
    initialConfig.plugins?.enabled === false
  ) {
    return { stillEligible: () => false };
  }
  const selected = resolveDecisionModelSetting(initialConfig, session.agentId);
  let adviserIsCurrent: (() => boolean) | undefined;
  let providerIsCurrent: (() => boolean) | undefined;
  const decisionAuthority: { assertCurrent?: () => void } = {};
  const stillEligible = () => {
    decisionAuthority.assertCurrent?.();
    const cfg = params.getConfig();
    const current = resolveDecisionModelSetting(cfg, session.agentId);
    return (
      isDecisionAssistanceEligible(cfg, session.agentId) &&
      cfg.plugins?.enabled !== false &&
      current?.provider === selected?.provider &&
      current?.model === selected?.model &&
      (adviserIsCurrent?.() ?? true) &&
      (providerIsCurrent?.() ?? true)
    );
  };
  if (!stillEligible()) {
    return { stillEligible: () => false };
  }
  const fallback = (reason: AutoSteerReceipt["reason"]) => ({ receipt: { reason }, stillEligible });
  const target = admission.autoSteerTarget;
  const operation = admission.expectedActiveReplyOperation;
  if (
    !target?.sourceTurnId ||
    !operation ||
    operation.turnKind !== "visible" ||
    !session.entry?.sessionId ||
    session.entry.incognito
  ) {
    return fallback("ineligible");
  }
  const deadlineMonotonicMs = performance.now() + DEADLINE_MS;
  const selectedForPolicy = selected
    ? normalizeModelRef(selected.provider, selected.model, {
        allowPluginNormalization: false,
        manifestPlugins: getProcessGatewayPluginMetadataSnapshot() ?? [],
      })
    : undefined;
  decisionAuthority.assertCurrent = () =>
    assertOperatorModelAllowed(admission.operatorAuthority, selectedForPolicy);
  const sourceTurnId = target.sourceTurnId;
  const entry = session.entry;
  const signal = admission.activeRunAbort.controller.signal;
  const targetCurrent = () =>
    replyRunRegistry.get(session.activeRunScopeKey) === operation &&
    !operation.result &&
    !operation.abortSignal.aborted;
  const assertCurrent = () => {
    signal.throwIfAborted();
    params.assertCurrent();
    decisionAuthority.assertCurrent?.();
  };
  assertCurrent();
  if (!targetCurrent()) {
    return fallback("stale-turn");
  }
  const deadline = new AbortController();
  const boundedSignal = AbortSignal.any([signal, deadline.signal]);
  let open = true;
  const assertAdviceCurrent = () => {
    assertCurrent();
    if (!open || !stillEligible() || !targetCurrent()) {
      throw new AdviceNoLongerEligible();
    }
    boundedSignal.throwIfAborted();
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<AutoSteerReceipt>((resolve) => {
    timer = setTimeout(
      () => {
        resolve({ reason: "deadline" });
        deadline.abort(new AdviceNoLongerEligible());
      },
      Math.max(0, deadlineMonotonicMs - performance.now()),
    );
  });
  const decide = async (): Promise<AutoSteerReceipt> => {
    const { getGlobalHookRunner } = await import("../../plugins/hook-runner-global.js");
    assertAdviceCurrent();
    if (performance.now() >= deadlineMonotonicMs) {
      return { reason: "deadline" };
    }
    const runner = getGlobalHookRunner();
    const pluginEligible = (pluginId: string) => {
      const cfg = params.getConfig();
      return (
        cfg.plugins?.enabled !== false &&
        cfg.plugins?.entries?.[pluginId]?.enabled !== false &&
        cfg.plugins?.entries?.[pluginId]?.hooks?.allowConversationAccess !== false
      );
    };
    const adviser = runner?.prepareInputRoute(pluginEligible);
    if (!adviser) {
      return { reason: "unavailable" };
    }
    adviserIsCurrent = adviser.isCurrent;
    const { inspectDecisionProviders } = await import("../../decisions/runtime.js");
    assertAdviceCurrent();
    const readProvider = () =>
      inspectDecisionProviders(params.getConfig()).find(
        (provider) => provider.providerId === selected?.provider,
      );
    const provider = readProvider();
    if (!provider?.callable) {
      return { reason: "unavailable" };
    }
    providerIsCurrent = () => {
      const current = readProvider();
      return (
        current?.callable === true &&
        current.pluginId === provider.pluginId &&
        current.runtimeGeneration === provider.runtimeGeneration
      );
    };
    const [{ readSessionHistoryPageInWorker }, { projectAutoSteerEvidence }] = await Promise.all([
      import("../../config/sessions/session-history-worker-runtime.js"),
      import("./chat-send-auto-steer-evidence.js"),
    ]);
    assertAdviceCurrent();
    if (performance.now() >= deadlineMonotonicMs) {
      return { reason: "deadline" };
    }
    const page = await readSessionHistoryPageInWorker(
      {
        kind: "rpc",
        params: {
          entry,
          provider: undefined,
          sessionId: entry.sessionId,
          storePath: session.storePath,
          sessionAgentId: session.agentId,
          canonicalKey: session.sessionKey,
          max: 12,
          maxHistoryBytes: 32_000,
          effectiveMaxChars: 12_000,
          offset: undefined,
          messageId: undefined,
          ignoreCliSessionImports: true,
        },
      },
      boundedSignal,
    ).catch(() => {
      assertAdviceCurrent();
      return undefined;
    });
    // Exact source ownership is rechecked BEFORE any evidence crosses into a plugin.
    assertAdviceCurrent();
    if (performance.now() >= deadlineMonotonicMs) {
      return { reason: "deadline" };
    }
    if (!page) {
      return { reason: "unavailable" };
    }
    const evidence = projectAutoSteerEvidence(page.messages, sourceTurnId, request.rawMessage);
    if (!evidence) {
      return { reason: "ineligible" };
    }
    assertAdviceCurrent();
    const result = await adviser.evaluate(evidence, {
      agentId: session.agentId,
      signal: boundedSignal,
      deadlineMonotonicMs,
      assertCurrent: assertAdviceCurrent,
    });
    assertAdviceCurrent();
    if (performance.now() >= deadlineMonotonicMs) {
      return { reason: "deadline" };
    }
    return result?.status === "choice"
      ? { choice: result.choice, reason: "decision" }
      : {
          reason:
            result?.status === "abstained"
              ? "abstained"
              : result?.reason === "deadline"
                ? "deadline"
                : "unavailable",
        };
  };
  try {
    const receipt = await racePromiseWithAbortSignal(Promise.race([decide(), expired]), signal);
    assertCurrent();
    if (!stillEligible()) {
      return fallback("ineligible");
    }
    if (!targetCurrent()) {
      return fallback("stale-turn");
    }
    return performance.now() >= deadlineMonotonicMs
      ? fallback("deadline")
      : { receipt, stillEligible, deadlineMonotonicMs };
  } catch (error) {
    // Cancellation and authority failures always win over optional deadline fallback.
    assertCurrent();
    if (error instanceof AdviceNoLongerEligible) {
      return fallback(
        !targetCurrent()
          ? "stale-turn"
          : performance.now() >= deadlineMonotonicMs
            ? "deadline"
            : "ineligible",
      );
    }
    throw error;
  } finally {
    open = false;
    clearTimeout(timer);
    deadline.abort(new AdviceNoLongerEligible());
  }
}

/** Optional advice expires until delivery takes custody; consumption remains runtime-owned. */
export async function prepareChatSendRouting(params: RoutingParams): Promise<{
  revalidate: () => void;
  takeCustody: () => void;
}> {
  const { admission, request, session } = params;
  const capturedTarget = admission.autoSteerTarget;
  const baselineTarget = admission.messageInjectionTarget;
  const operation = admission.expectedActiveReplyOperation;
  // Capture the submitted server baseline before optional work. A later config
  // update cannot turn fallback into a different, potentially interrupting action.
  const baselineMode = resolveQueueSettingsCore({
    cfg: params.getConfig(),
    channel: INTERNAL_MESSAGE_CHANNEL,
    sessionEntry: session.entry,
    inlineMode: request.p.queueMode,
  }).mode;
  const { receipt, stillEligible, deadlineMonotonicMs } = await resolveAutoRoute(
    params,
    baselineMode,
  );
  request.autoSteer = receipt;
  let custodyTransferred = false;
  const takeCustody = () => {
    if (custodyTransferred) {
      return;
    }
    custodyTransferred = true;
    admission.inputRouting?.release();
  };
  if (!receipt && !admission.inputRouting) {
    return { revalidate: () => {}, takeCustody };
  }
  const revalidate = () => {
    params.assertCurrent();
    if (custodyTransferred) {
      return;
    }
    if (
      request.autoSteer?.reason === "decision" &&
      (!stillEligible() ||
        replyRunRegistry.get(session.activeRunScopeKey) !== operation ||
        operation?.result)
    ) {
      request.autoSteer = { reason: stillEligible() ? "stale-turn" : "ineligible" };
    }
    if (
      request.autoSteer?.reason === "decision" &&
      deadlineMonotonicMs !== undefined &&
      performance.now() >= deadlineMonotonicMs
    ) {
      request.autoSteer = { reason: "deadline" };
    }
    request.resolvedQueueMode =
      request.autoSteer?.reason === "decision"
        ? request.autoSteer.choice
        : capturedTarget
          ? baselineMode
          : request.p.queueMode;
    // The existing queue owner resolves inherited policy. Even its steer fallback
    // may use only the original candidate; detached dispatch cannot discover another.
    admission.messageInjectionTarget =
      request.autoSteer?.reason === "decision"
        ? request.autoSteer.choice === "steer"
          ? capturedTarget
          : undefined
        : baselineMode === "steer"
          ? (baselineTarget ?? capturedTarget)
          : undefined;
  };
  if (admission.inputRouting) {
    await racePromiseWithAbortSignal(
      admission.inputRouting.ready,
      admission.activeRunAbort.controller.signal,
    );
  }
  revalidate();
  return { revalidate, takeCustody };
}
