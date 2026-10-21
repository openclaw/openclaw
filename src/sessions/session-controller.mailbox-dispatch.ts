/** Selection, preparation and dispatch share one mailbox-owned lifecycle. */
import { runOutsidePreparedModelRuntimePluginGenerationScope } from "../agents/prepared-model-runtime-generation-scope.js";
import {
  prepareNextDeliveryGroup,
  resolveFollowupDeliveryStorageKey,
} from "../auto-reply/reply/queue/delivery-context.js";
import { requiresIndividualCollectDrain } from "../auto-reply/reply/queue/envelope.js";
import { updateFollowupRetryHeartbeatsWithCustody } from "../auto-reply/reply/queue/pre-adoption-heartbeat.js";
import {
  FollowupRunDeferredError,
  isFollowupRunAborted,
  type FollowupRun,
} from "../auto-reply/reply/queue/types.js";
import { captureGatewayScopeMatcher } from "../gateway/session-runtime-scope.js";
import { notifyGatewayWorkMetricsChanged } from "../infra/gateway-work-metrics-events.js";
import {
  bindGatewayContextResolver,
  getGatewayContextResolver,
  withPluginRuntimeGatewayContextResolver,
} from "../plugins/runtime/gateway-request-scope.js";
import {
  isGatewayRestartDrainError,
  isGatewayRestartDraining,
  runWithGatewayDetachedWorkContinuation,
} from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { createDeferredCore } from "../shared/deferred.js";
import { AgentDatabaseExecutionAdmissionClosedError } from "../state/agent-database-admission-error.js";
import { evaluateTurnAdmission, isMutationOwnedTurn } from "./session-controller.admission-rule.js";
import type {
  SessionControllerInput,
  SessionControllerMailboxClaim,
  SessionControllerMailbox,
} from "./session-controller.contracts.js";
import { logSessionControllerSourceClaim } from "./session-controller.diagnostics.js";
import { captureSessionControllerMailboxSummarySources as summaryCandidates } from "./session-controller.mailbox-cleanup.js";
import {
  settleSessionControllerSourceInjectionOrder,
  retireSessionControllerInput,
} from "./session-controller.mailbox-source.js";
import { sessionControllers, pruneSessionControllerEntry } from "./session-controller.state.js";

type MailboxSelection = {
  first: SessionControllerInput;
  priority: SessionControllerInput | undefined;
  sources: FollowupRun[];
  isSummary: boolean;
  prepareDelivery: boolean;
};

function selectSessionControllerMailbox(
  mailbox: SessionControllerMailbox,
): MailboxSelection | undefined {
  const { owner, priority } = mailbox;
  const summaries = summaryCandidates(mailbox);
  const eligible = mailbox.entries.filter(
    (input) => input.phase !== "consumed" && !input.claim?.operation?.admissionRetired,
  );
  // A mutation awaits its own turn, so that turn precedes inputs its fence keeps waiting.
  const first =
    eligible.find((input) => isMutationOwnedTurn(owner, input)) ?? priority ?? eligible[0];
  if (!first) {
    return undefined;
  }
  if (!first.ready && !first.task && isGatewayRestartDraining()) {
    // Do not start queued policy preparation that would resume on rollback alone.
    mailbox.dispatchEnabled = false;
    return undefined;
  }
  // Settled predecessors yield to the next steer before fallback dispatch;
  // an unresolved raw reservation still needs its earlier turn selected.
  const pendingInjection = eligible.find(
    (input) => !input.claim && !input.injectionOrder.resolved,
  )?.injection;
  const admission = evaluateTurnAdmission(owner, {
    kind: first.taskTurnKind ?? (first.custody.enqueued ? "queued_followup" : "visible"),
    sessionKey: owner.key,
    registeredEntry: sessionControllers.get(owner.id),
    selectedInput: first,
  });
  if (
    !admission.admitted ||
    first.retirementRequested ||
    first.phase !== "waiting" ||
    first.injection ||
    first.withdrawalHolds > 0 ||
    pendingInjection ||
    eligible.some(
      (input) =>
        input.injection?.admitted || (input.policy.mode === "interrupt" && input.injection),
    ) ||
    (!first.ready &&
      !first.task &&
      (first.payload === "unbound" ||
        !mailbox.dispatchEnabled ||
        !mailbox.dispatch ||
        !first.source))
  ) {
    return undefined;
  }
  let sources = first.source ? [first.source] : [];
  const isSummary = !priority && first.source !== undefined && summaries.includes(first.source);
  const prepareDelivery = Boolean(
    !priority &&
    first.source &&
    !first.ready &&
    !first.task &&
    !requiresIndividualCollectDrain(first.source) &&
    (isSummary || first.policy.mode === "collect"),
  );
  if (prepareDelivery && first.source) {
    const context = resolveFollowupDeliveryStorageKey(first.source);
    const matchesGateway = captureGatewayScopeMatcher(getGatewayContextResolver(first));
    const candidates = isSummary ? summaries : mailbox.items;
    const start = candidates.indexOf(first.source);
    let previousInput = first;
    for (const candidate of candidates.slice(start + 1)) {
      const input = candidate.controllerInput;
      if (
        !input ||
        mailbox.entries.indexOf(input) !== mailbox.entries.indexOf(previousInput) + 1 ||
        input.retirementRequested ||
        input.phase !== "waiting" ||
        input.injection ||
        input.ready ||
        input.task ||
        input.policy.mode !== first.policy.mode ||
        input.withdrawalHolds ||
        !matchesGateway(input) ||
        requiresIndividualCollectDrain(candidate) ||
        resolveFollowupDeliveryStorageKey(candidate) !== context
      ) {
        break;
      }
      sources.push(candidate);
      previousInput = input;
    }
  }
  sources = sources.filter((source) => !isFollowupRunAborted(source));
  return { first, priority, sources, isSummary, prepareDelivery };
}

/** The only successor selector; capability preparation finishes before it creates a claim. */
export function pumpSessionControllerMailbox(mailbox: SessionControllerMailbox): void {
  if (mailbox.preparing) {
    return;
  }
  const selection = selectSessionControllerMailbox(mailbox);
  if (!selection) {
    disposeSessionControllerMailbox(mailbox);
    return;
  }
  const { first, priority, sources } = selection;
  const delay =
    first.ready || first.task || priority
      ? 0
      : Math.max(0, mailbox.lastEnqueuedAt + mailbox.debounceMs - Date.now());
  if (delay > 0) {
    clearTimeout(mailbox.timer);
    mailbox.timer = setTimeout(() => {
      mailbox.timer = undefined;
      mailbox.wake();
    }, delay);
    mailbox.timer.unref?.();
    return;
  }
  if (first.source && sources.length === 0) {
    first.payload = "unbound";
    retireSessionControllerInput(first);
    return;
  }
  if (selection.prepareDelivery) {
    void prepareSessionControllerMailboxSelection(mailbox, selection);
  } else {
    claimSessionControllerMailboxSelection(mailbox, selection);
  }
}

async function prepareSessionControllerMailboxSelection(
  mailbox: SessionControllerMailbox,
  selection: MailboxSelection,
): Promise<void> {
  mailbox.preparing = true;
  const generation = mailbox.abortController;
  const matchesGateway = captureGatewayScopeMatcher(getGatewayContextResolver(selection.first));
  let currentSelection = selection;
  const assertCurrent = () => {
    const current = selectSessionControllerMailbox(mailbox);
    if (
      generation !== mailbox.abortController ||
      generation.signal.aborted ||
      mailbox.owner.mailbox !== mailbox ||
      !matchesGateway(selection.first) ||
      !current ||
      current.first !== selection.first ||
      current.priority !== selection.priority ||
      current.isSummary !== selection.isSummary ||
      current.prepareDelivery !== selection.prepareDelivery ||
      selection.sources.some((source, index) => current.sources[index] !== source)
    ) {
      throw new FollowupRunDeferredError("Mailbox selection changed during delivery preparation");
    }
    for (const source of selection.sources) {
      source.controllerInput?.abortSignal.throwIfAborted();
      source.controllerInput?.sourceAdapter?.authority?.assertCurrent();
    }
    currentSelection = current;
  };
  let retry = true;
  let preparedSelection: MailboxSelection | undefined;
  try {
    const prepared = await withPluginRuntimeGatewayContextResolver(
      getGatewayContextResolver(selection.first),
      () =>
        runWithGatewayDetachedWorkContinuation(
          () =>
            runOutsidePreparedModelRuntimePluginGenerationScope(() =>
              prepareNextDeliveryGroup(() => selection.sources, assertCurrent),
            ),
          "session:mailbox-preparation",
        ),
      { inheritRequestScope: false },
    );
    prepared.assertCurrent();
    preparedSelection = { ...currentSelection, sources: prepared.items };
  } catch (error) {
    updateFollowupRetryHeartbeatsWithCustody(
      error,
      selection.sources,
      (source) => source.controllerClaim?.custody ?? source.controllerInput!.custody,
    );
    mailbox.lastEnqueuedAt = Date.now();
    retry = !(error instanceof AgentDatabaseExecutionAdmissionClosedError);
    if (!(error instanceof FollowupRunDeferredError)) {
      if (isGatewayRestartDrainError(error)) {
        mailbox.dispatchEnabled = false;
        retry = false;
      } else {
        defaultRuntime.error?.(
          "mailbox delivery preparation failed for " + mailbox.key + ": " + String(error),
        );
      }
    }
  } finally {
    mailbox.preparing = false;
  }
  if (preparedSelection) {
    claimSessionControllerMailboxSelection(mailbox, preparedSelection);
  } else if (retry && mailbox.owner.mailbox === mailbox && !mailbox.claim) {
    clearTimeout(mailbox.timer);
    mailbox.timer = setTimeout(
      () => {
        mailbox.timer = undefined;
        mailbox.wake();
      },
      Math.max(1, mailbox.debounceMs),
    );
    mailbox.timer.unref?.();
  }
}

function claimSessionControllerMailboxSelection(
  mailbox: SessionControllerMailbox,
  { first, sources, isSummary }: MailboxSelection,
): void {
  const inputs = sources.length ? sources.map((source) => source.controllerInput!) : [first];
  const claim: SessionControllerMailboxClaim = {
    mailbox,
    inputs,
    sources,
    summary: isSummary,
    custody: {},
    released: false,
    settlement: createDeferredCore(),
    abortController: new AbortController(),
  };
  // Selection can be woken by another Gateway's retiring stack. Attribution
  // follows the captured source, never that incidental async context.
  bindGatewayContextResolver(claim, getGatewayContextResolver(first));
  mailbox.claim = claim;
  if (mailbox.priority === first) {
    mailbox.priority = undefined;
  }
  for (const input of inputs) {
    settleSessionControllerSourceInjectionOrder(input, false);
    input.phase = "claimed";
    input.claim = claim;
    logSessionControllerSourceClaim(input, "selected");
  }
  notifyGatewayWorkMetricsChanged();
  if (first.ready) {
    first.ready(claim);
  } else if (first.task) {
    first.task(claim);
  } else {
    void mailbox.dispatch!(claim);
  }
}

function disposeSessionControllerMailbox(mailbox: SessionControllerMailbox): void {
  const now = Date.now();
  for (const [key, value] of mailbox.recentSources) {
    if (value.expires <= now) {
      mailbox.recentSources.delete(key);
    }
  }
  if (mailbox.entries.length || mailbox.claim || mailbox.priority || mailbox.droppedCount) {
    return;
  }
  mailbox.dispatch = undefined;
  mailbox.dispatchEnabled = false;
  mailbox.lastRun = undefined;
  clearTimeout(mailbox.timer);
  if (mailbox.recentSources.size) {
    const expires = Math.min(...[...mailbox.recentSources.values()].map((value) => value.expires));
    mailbox.timer = setTimeout(
      () => {
        mailbox.timer = undefined;
        disposeSessionControllerMailbox(mailbox);
      },
      Math.max(1, expires - now),
    );
    mailbox.timer.unref?.();
    return;
  }
  if (mailbox.owner.mailbox === mailbox) {
    mailbox.owner.mailbox = undefined;
  }
  pruneSessionControllerEntry(mailbox.owner);
}
