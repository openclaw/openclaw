import { createAgentRunRestartAbortError } from "../agents/run-termination.js";
/** Captured mailbox batch cleanup and summary bookkeeping. */
import type { FollowupRun } from "../auto-reply/reply/queue/types.js";
import { getGatewayRestartDrainSignal } from "../process/gateway-work-admission.js";
import { defaultRuntime } from "../runtime.js";
import { isCurrentSessionControllerTurnInput } from "./session-controller.context.js";
import type {
  SessionControllerInput,
  SessionControllerMailbox,
} from "./session-controller.contracts.js";
import {
  abortSessionControllerInput,
  completeSessionControllerSourceLifecycle,
  retireSessionControllerInput,
} from "./session-controller.mailbox-source.js";
import { runWithSessionControllerCleanup } from "./session-controller.owner-context.js";
import { sessionControllers } from "./session-controller.state.js";

let followedRestartDrainSignal: AbortSignal | undefined;

/** Snapshots aggregate summary sources shared by selection and captured cleanup. */
export function captureSessionControllerMailboxSummarySources(
  mailbox: SessionControllerMailbox,
): FollowupRun[] {
  return [...mailbox.summaryElisions.flatMap((part) => part.sources), ...mailbox.summarySources];
}

/** Removes only authorized captured sources; reentrant successors keep their summaries. */
function detachSummarySources(
  mailbox: SessionControllerMailbox,
  selectedSource: (source: FollowupRun) => boolean,
): number {
  let removed = 0;
  for (let index = mailbox.summarySources.length - 1; index >= 0; index--) {
    if (selectedSource(mailbox.summarySources[index]!)) {
      mailbox.summarySources.splice(index, 1);
      mailbox.summaryLines.splice(index, 1);
      removed++;
    }
  }
  for (const entry of mailbox.summaryElisions) {
    for (let index = entry.sources.length - 1; index >= 0; index--) {
      if (selectedSource(entry.sources[index]!)) {
        entry.sources.splice(index, 1);
        entry.summaryLines.splice(index, 1);
        removed++;
      }
    }
    for (const [original, compact] of entry.sourceRefs) {
      if (selectedSource(compact)) {
        entry.sourceRefs.delete(original);
      }
    }
    entry.count = entry.sources.length;
  }
  mailbox.summaryElisions = mailbox.summaryElisions.filter((entry) => entry.count > 0);
  mailbox.droppedCount = Math.max(0, mailbox.droppedCount - removed);
  return removed;
}

/**
 * Applies each captured input before proceeding to the next cancellation effect.
 * A clear requested from inside a turn never selects that turn's own input.
 */
export function clearSessionControllerMailbox(
  mailbox: SessionControllerMailbox,
  settleSource: (source: FollowupRun) => void,
  capturedInputs?: readonly SessionControllerInput[],
  assertCurrent: () => void = () => {},
  reason: unknown = new Error("Session mailbox cleared"),
): number {
  const inputs = capturedInputs
    ? capturedInputs.filter(
        (input) =>
          input.mailbox === mailbox &&
          mailbox.entries.includes(input) &&
          !input.retirementRequested &&
          input.phase !== "consumed" &&
          !isCurrentSessionControllerTurnInput(input),
      )
    : mailbox.entries.filter((input) => !isCurrentSessionControllerTurnInput(input));
  const selected = new Set(inputs);
  const summarySources = captureSessionControllerMailboxSummarySources(mailbox);
  const sources = new Map(
    [
      ...new Set([
        ...inputs.flatMap((input) => (input.source ? [input.source] : [])),
        ...summarySources.filter(
          (source) =>
            !capturedInputs || (source.controllerInput && selected.has(source.controllerInput)),
        ),
      ]),
    ].map((source) => [source, source.controllerInput]),
  );
  const cleared = capturedInputs ? inputs.length : mailbox.items.length + mailbox.droppedCount;
  const abort = mailbox.abortController;
  const nextAbort = capturedInputs ? undefined : new AbortController();
  const timer = mailbox.timer;
  const droppedCount = mailbox.droppedCount;
  let removedSummaries = 0;
  const wasClearing = mailbox.clearing;
  mailbox.clearing = true;
  const settle = (source: FollowupRun, input: SessionControllerInput | undefined) => {
    if (
      source.controllerInput !== input ||
      (input?.claim && !input.claim.released) ||
      input?.phase === "injecting"
    ) {
      return;
    }
    assertCurrent();
    try {
      settleSource(source);
    } catch (error) {
      defaultRuntime.error?.("mailbox clear custody failed: " + String(error));
    }
  };
  try {
    if (nextAbort) {
      assertCurrent();
      // Reentrant enqueues belong to the next generation; the captured one stays live
      // until this clear has permission to cancel every selected input.
      mailbox.abortController = nextAbort;
    }
    for (const input of inputs) {
      assertCurrent();
      // Detach only this authorized input. A callback can revoke the rest of the capture.
      removedSummaries += detachSummarySources(
        mailbox,
        (source) => source.controllerInput === input,
      );
      for (const [key, record] of mailbox.recentSources) {
        if (record.input === input && !input.custody.adopted && input.phase !== "consumed") {
          mailbox.recentSources.delete(key);
        }
      }
      if (mailbox.priority === input) {
        mailbox.priority = undefined;
      }
      input.retirementRequested = true;
      try {
        if (!input.withdrawalHolds) {
          abortSessionControllerInput(input, reason, assertCurrent);
        }
        for (const [source, capturedInput] of sources) {
          if (capturedInput === input) {
            sources.delete(source);
            settle(source, capturedInput);
          }
        }
      } finally {
        // Cleanup of a committed cancellation keeps its original source custody.
        retireSessionControllerInput(input);
      }
    }
    for (const [source, capturedInput] of sources) {
      if (source.controllerInput !== capturedInput) {
        continue;
      }
      assertCurrent();
      removedSummaries += detachSummarySources(mailbox, (candidate) => candidate === source);
      settle(source, capturedInput);
    }
    if (nextAbort && mailbox.abortController === nextAbort) {
      assertCurrent();
      mailbox.droppedCount = Math.max(
        0,
        mailbox.droppedCount - Math.max(0, droppedCount - removedSummaries),
      );
      if (
        !mailbox.entries.some(
          (input) => !selected.has(input) && !isCurrentSessionControllerTurnInput(input),
        )
      ) {
        mailbox.dispatch = undefined;
        mailbox.dispatchEnabled = false;
        mailbox.lastRun = undefined;
        mailbox.lastEnqueuedAt = 0;
      }
      clearTimeout(timer);
      if (mailbox.timer === timer) {
        mailbox.timer = undefined;
      }
      abort.abort();
    }
  } finally {
    mailbox.clearing = wasClearing;
    mailbox.wake();
  }
  return cleared;
}

/** Waiting inputs retire on restart; active producers remain with the shutdown drain owner. */
export function bindSessionControllerMailboxRestartDrain(): void {
  const signal = getGatewayRestartDrainSignal();
  if (followedRestartDrainSignal === signal) {
    return;
  }
  followedRestartDrainSignal = signal;
  signal.addEventListener(
    "abort",
    () => {
      // Capture owners before cleanup can mutate the registry or publish a successor.
      const mailboxes = [...sessionControllers.values()].flatMap((owner) =>
        owner.mailbox ? [owner.mailbox] : [],
      );
      // Restart may originate inside a turn; selection must not depend on its context.
      runWithSessionControllerCleanup(() => {
        for (const mailbox of mailboxes) {
          const waiting = mailbox.entries.filter(
            (input) => (!input.claim || input.claim.released) && input.phase !== "injecting",
          );
          clearSessionControllerMailbox(
            mailbox,
            completeRestartClearedSource,
            waiting,
            undefined,
            createAgentRunRestartAbortError(),
          );
        }
      });
    },
    { once: true },
  );
}

// Use the existing source custody without submitting missing followup work.
function completeRestartClearedSource(source: FollowupRun): void {
  const input = source.controllerInput;
  if (input) {
    completeSessionControllerSourceLifecycle(
      source,
      source.controllerClaim?.custody ?? input.custody,
    );
  }
}
