/** Producer occurrences that arrive while the session's previous one runs share its next turn. */
import { readExecRequestOwners } from "../../infra/exec-request-context.js";
import { resolveSystemEventQueueKey } from "../../infra/system-event-ownership.js";
import { consumeSelectedSystemEventEntries } from "../../infra/system-events.js";
import { channelRouteDedupeKey } from "../../plugin-sdk/channel-route.js";
import { createDeferredCore, type Deferred } from "../../shared/deferred.js";
import {
  claimSessionEventOccurrenceInput,
  prepareSessionEventInput,
} from "./session-event-context.js";
import type {
  SessionEventOptions,
  SessionEventOutcome,
  SessionEventReceipt,
} from "./session-event-contract.js";
import {
  combineSessionEventTargetsForHost,
  enqueueSessionEventForHost,
} from "./session-event-handoff.js";

type HeldOccurrence = ReturnType<typeof claimSessionEventOccurrenceInput> & {
  options: SessionEventOptions & {
    expectedTarget: NonNullable<SessionEventOptions["expectedTarget"]>;
  };
  queueKey: string;
  retired: boolean;
  releaseAuthority?: () => void;
  settled: Deferred<SessionEventOutcome>;
  accepted: Deferred<Awaited<SessionEventReceipt["accepted"]>>;
  batch?: { receipt: SessionEventReceipt; size: number; cancelled: Set<HeldOccurrence> };
};

/** One in-flight turn per session; occurrences arriving meanwhile wait for its settlement. */
const lanes = new Map<string, HeldOccurrence[]>();

/**
 * Admit one producer occurrence. With no turn of this lane in flight it starts at once,
 * like enqueueSessionEventForHost. Otherwise it waits, and every compatible occurrence still
 * waiting when that turn settles starts one shared turn.
 *
 * Accepted edges: waiting occurrences start after the in-flight turn settles, so a human
 * message queued in followup or collect mode meanwhile may run first; once a shared turn is
 * queued, one member's removal no longer edits its prompt.
 */
export function enqueueBatchedSessionEventForHost(
  text: string,
  options: SessionEventOptions,
): SessionEventReceipt {
  const target = options.expectedTarget;
  // Cron-run completions keep their acceptance-time origin check; they never wait here.
  if (!target || options.occurrences || options.assertAcceptanceCurrent) {
    return enqueueSessionEventForHost(text, options);
  }
  const key = JSON.stringify([options.agentId, options.sessionKey]);
  const held = lanes.get(key);
  if (!held) {
    const receipt = enqueueSessionEventForHost(text, options);
    track(key, [], receipt);
    return receipt;
  }
  options.assertCurrent?.();
  target.assertCurrent?.();
  const { agentId, sessionKey, operatorAuthority } = prepareSessionEventInput(text, options);
  const ref: { member?: HeldOccurrence } = {};
  const claim = claimSessionEventOccurrenceInput({
    text,
    options,
    sessionKey,
    agentId,
    route: structuredClone(options.deliveryContext ?? target.deliveryContext),
    execRequestOwners: readExecRequestOwners(options),
    // Queue retirement (restart, store replacement, Stop) settles a waiting occurrence.
    cancel: () => ref.member && retire(key, ref.member),
  });
  const member: HeldOccurrence = {
    ...claim,
    options: { ...options, expectedTarget: target },
    queueKey: resolveSystemEventQueueKey(sessionKey, agentId),
    retired: false,
    settled: createDeferredCore(),
    accepted: createDeferredCore(),
  };
  try {
    // The completed process may release its source; this occurrence keeps it until admission.
    member.releaseAuthority = operatorAuthority?.retain?.();
  } catch (error) {
    claim.ownership.cancel();
    throw error;
  }
  ref.member = member;
  held.push(member);
  return {
    id: claim.occurrenceId,
    cancel: () => {
      const batch = member.batch;
      if (!batch) {
        return !member.retired && claim.ownership.cancel();
      }
      // A shared turn carries other results; retire it only when every member is removed.
      batch.cancelled.add(member);
      return batch.cancelled.size === batch.size && batch.receipt.cancel();
    },
    settled: member.settled.promise,
    accepted: member.accepted.promise,
  };
}

function retire(key: string, member: HeldOccurrence) {
  if (member.retired || member.batch) {
    return;
  }
  member.retired = true;
  const held = lanes.get(key) ?? [];
  if (held.includes(member)) {
    held.splice(held.indexOf(member), 1);
  }
  member.releaseAuthority?.();
  member.accepted.resolve({ ok: false, error: "Session event was cancelled before acceptance" });
  member.settled.resolve({ status: "cancelled", executionStarted: false, delivered: false });
}

function track(key: string, held: HeldOccurrence[], receipt: SessionEventReceipt) {
  lanes.set(key, held);
  const next = () => flush(key, held);
  void receipt.settled.then(next, next);
}

function sameBatch(first: HeldOccurrence, member: HeldOccurrence): boolean {
  const owners = new Set(readExecRequestOwners(first.options));
  const memberOwners = readExecRequestOwners(member.options) ?? [];
  // Stop retires every owner's shared turn, so only one request's occurrences share it.
  return (
    owners.size === new Set(memberOwners).size &&
    memberOwners.every((owner) => owners.has(owner)) &&
    channelRouteDedupeKey(first.options.deliveryContext) ===
      channelRouteDedupeKey(member.options.deliveryContext)
  );
}

function flush(key: string, held: HeldOccurrence[]) {
  const first = held[0];
  if (!first) {
    lanes.delete(key);
    return;
  }
  const group = [first];
  let target = first.options.expectedTarget;
  for (const member of held.slice(1)) {
    if (!sameBatch(first, member)) {
      break;
    }
    try {
      target = combineSessionEventTargetsForHost(
        [...group, member].map((item) => item.options.expectedTarget),
      );
    } catch {
      break;
    }
    group.push(member);
  }
  held.splice(0, group.length);
  const occurrences = group.map((member) => member.occurrence);
  for (const member of group) {
    // Return custody to the queue so the shared turn claims the exact occurrences.
    member.ownership.release();
  }
  let receipt: SessionEventReceipt;
  try {
    receipt = enqueueSessionEventForHost(occurrences.map((event) => event.text).join("\n"), {
      ...first.options,
      expectedTarget: target,
      occurrences,
    });
  } catch (error) {
    // A rejected occurrence carries no producer contract; consume it.
    consumeSelectedSystemEventEntries(first.queueKey, occurrences);
    for (const member of group) {
      member.retired = true;
      member.releaseAuthority?.();
      member.accepted.resolve({ ok: false, error: String(error) });
      member.settled.resolve({
        status: "failed",
        executionStarted: false,
        delivered: false,
        error: String(error),
      });
    }
    flush(key, held);
    return;
  }
  const batch = { receipt, size: group.length, cancelled: new Set<HeldOccurrence>() };
  for (const member of group) {
    member.batch = batch;
    member.releaseAuthority?.();
    member.accepted.resolve(receipt.accepted);
    member.settled.resolve(receipt.settled);
  }
  track(key, held, receipt);
}
