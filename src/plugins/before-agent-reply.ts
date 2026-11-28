import { AsyncLocalStorage } from "node:async_hooks";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../auto-reply/tokens.js";
import { runOncePerAgentRun } from "../infra/agent-events.js";
import type { DiagnosticEmbeddedRunOwner } from "../infra/diagnostic-model-request-provenance.js";
import { emitCoreSemanticRunProgressDiagnosticEvent } from "../infra/diagnostic-semantic-run-progress.js";
import { withGuardedFetchRequestAuthority } from "../infra/net/fetch-request-authority.js";
import {
  closeDiagnosticEmbeddedRunOwner,
  createDiagnosticEmbeddedRunOwner,
} from "../logging/diagnostic-run-activity.js";
import type { SessionControllerWatchdog } from "../sessions/session-controller.watchdog.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { readClaimingHookAdmission, withClaimingHookAdmission } from "./hook-claim-admission.js";
import { getGlobalHookRunner } from "./hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookBeforeAgentReplyEvent,
  PluginHookBeforeAgentReplyResult,
} from "./hook-types.js";
import { isPluginHookAgentTrigger } from "./hook-types.js";

const BEFORE_AGENT_REPLY_OBSERVER_KEY = Symbol.for("openclaw.beforeAgentReply.observer");

type BeforeAgentReplyObserver = {
  beforeDispatch: () => Promise<boolean | void>;
  afterDispatch: (
    result: PluginHookBeforeAgentReplyResult | undefined,
  ) => Promise<PluginHookBeforeAgentReplyResult | undefined>;
};

type BeforeAgentReplyObserverScope = BeforeAgentReplyObserver & { runId?: string };

const beforeAgentReplyObserver = resolveGlobalSingleton<
  AsyncLocalStorage<BeforeAgentReplyObserverScope>
>(BEFORE_AGENT_REPLY_OBSERVER_KEY, () => new AsyncLocalStorage());

/** Attaches durable admission bookkeeping without moving hook ownership out of the runner. */
export function withBeforeAgentReplyObserver<T>(
  observer: BeforeAgentReplyObserver,
  run: () => T,
): T {
  return beforeAgentReplyObserver.run({ ...observer }, run);
}

/** Preserves the full plugin reply contract, including private payload metadata. */
export function buildHandledBeforeAgentReplyPayloads(reply?: ReplyPayload): ReplyPayload[] {
  return [reply ?? { text: SILENT_REPLY_TOKEN }];
}

/** Runs the reply claim hook once for one admitted turn, across model fallbacks. */
export function runBeforeAgentReplyForTurn(params: {
  runId: string;
  trigger?: string;
  event: PluginHookBeforeAgentReplyEvent;
  context: PluginHookAgentContext;
  assertCurrent?: () => void;
  awaitSessionDiffBaseline?: () => Promise<void>;
  onDispatch?: () => void;
  onDeclined?: () => void;
  onProgress?: (detail?: string) => void;
  diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  watchdog?: Pick<SessionControllerWatchdog, "attachAttempt">;
}): Promise<PluginHookBeforeAgentReplyResult | undefined> {
  const trigger = params.trigger;
  if (!isPluginHookAgentTrigger(trigger)) {
    return Promise.resolve(undefined);
  }
  const context: PluginHookAgentContext = { ...params.context, trigger };
  const inherited = readClaimingHookAdmission(context);
  const assertCurrent = params.assertCurrent
    ? () => {
        inherited?.assertCurrent?.();
        params.assertCurrent?.();
      }
    : inherited?.assertCurrent;
  const run = () =>
    runOncePerAgentRun(params.runId, "before_agent_reply", async () => {
      const hookRunner = getGlobalHookRunner();
      if (!hookRunner?.hasHooks("before_agent_reply", context)) {
        return undefined;
      }
      await params.awaitSessionDiffBaseline?.();
      assertCurrent?.();
      const observerScope = beforeAgentReplyObserver.getStore();
      // Nested agent runs inherit async context. Bind recovery to the first runner
      // so a hook-spawned child cannot checkpoint its parent's admitted turn.
      const observer =
        observerScope && (!observerScope.runId || observerScope.runId === params.runId)
          ? observerScope
          : undefined;
      if (observer && !observer.runId) {
        observer.runId = params.runId;
      }
      if ((await observer?.beforeDispatch()) === false) {
        return undefined;
      }
      assertCurrent?.();
      params.onDispatch?.();
      assertCurrent?.();
      const ownedDiagnosticOwner =
        !params.diagnosticOwner && params.watchdog
          ? createDiagnosticEmbeddedRunOwner({
              runId: params.runId,
              sessionId: context.sessionId,
              sessionKey: context.sessionKey,
              watchdogAttempt: params.watchdog.attachAttempt({
                assertCurrent: () => assertCurrent?.(),
              }),
            })
          : undefined;
      const progressOwner = params.diagnosticOwner ?? ownedDiagnosticOwner;
      let dispatchActive = false;
      if (params.onProgress || progressOwner) {
        context.reportProgress = (detail?: string) => {
          if (!dispatchActive) {
            return;
          }
          try {
            assertCurrent?.();
          } catch {
            return;
          }
          params.onProgress?.(detail);
          if (!progressOwner) {
            return;
          }
          const trimmed = detail?.trim();
          emitCoreSemanticRunProgressDiagnosticEvent(
            {
              runId: params.runId,
              sessionId: context.sessionId,
              sessionKey: context.sessionKey,
              reason: trimmed ? `before_agent_reply:${trimmed}` : "before_agent_reply:progress",
            },
            progressOwner,
          );
        };
      }
      let result: PluginHookBeforeAgentReplyResult | undefined;
      dispatchActive = true;
      try {
        result = await hookRunner.runBeforeAgentReply(params.event, context);
      } finally {
        dispatchActive = false;
        if (ownedDiagnosticOwner) {
          closeDiagnosticEmbeddedRunOwner(ownedDiagnosticOwner);
        }
      }
      assertCurrent?.();
      if (!result?.handled) {
        params.onDeclined?.();
      }
      assertCurrent?.();
      if (observer) {
        result = await observer.afterDispatch(result);
      }
      assertCurrent?.();
      return result;
    });
  return assertCurrent
    ? withGuardedFetchRequestAuthority(assertCurrent, async (scopedAssertCurrent) => {
        withClaimingHookAdmission(context, { ...inherited, assertCurrent: scopedAssertCurrent });
        const result = await run();
        scopedAssertCurrent?.();
        return result;
      })
    : run();
}
