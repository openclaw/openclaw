import type { WorkerLiveEventParams as Params } from "../../../packages/gateway-protocol/src/schema.js";
import {
  loadSessionEntry,
  upsertSessionEntryCore,
  type SessionTranscriptRuntimeTarget,
} from "../../config/sessions/session-accessor.js";
import {
  resolveSqliteReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { captureSessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { runOpenClawAgentWorkerWrite } from "../../state/openclaw-agent-write-admission.js";
import type { WorkerConnectionIdentity as Identity } from "./connection-identity.js";
import { prepareWorkerTurnTranscriptSource } from "./worker-turn-transcript-target.js";

export const SID = "session-worker-live";
export const KEY = "agent:main:worker-live";
export const EPOCH = 7;
export const RUN = "run-worker-live";
export const LOCAL = { agentId: "main", sessionId: SID, sessionKey: KEY };
function connectionIdentity(
  environmentId: string,
  sessionId: string,
  runId: string,
  claimId: string,
): Identity {
  return {
    environmentId,
    credentialHash: ["credential", "hash", "live"].join("-"),
    bundleHash: "b".repeat(64),
    sessionId,
    runId,
    turnClaim: {
      sessionId,
      claimId,
      runId,
      placementGeneration: 4,
      owner: { kind: "worker", environmentId, ownerEpoch: EPOCH },
    },
    ownerEpoch: EPOCH,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-live-event-v1"],
    credentialExpiresAtMs: 10_000,
  };
}
export const ID = connectionIdentity("environment-live", SID, RUN, "claim-worker-live");
export const farmIdentity = (n: number) =>
  connectionIdentity(
    `environment-farm-${n}`,
    `session-farm-${n}`,
    `run-farm-${n}`,
    `claim-farm-${n}`,
  );

export const msg = (seq: number, delta = "hello", ack = 0, runId = RUN, epoch = EPOCH): Params => ({
  ...live(seq, { kind: "assistant", payload: { text: delta, delta } }, runId),
  runEpoch: epoch,
  lastAckedSeq: ack,
});

export function live(seq: number, event: Params["event"], runId = RUN): Params {
  return { runEpoch: EPOCH, lastAckedSeq: seq - 1, seq, runId, event };
}

export type WireEvent = Params["event"];
type Payload<K extends WireEvent["kind"]> = Extract<WireEvent, { kind: K }>["payload"];
export const tool = (payload: Payload<"tool">): WireEvent => ({ kind: "tool", payload });
export const approval = (payload: Payload<"approval">): WireEvent => ({
  kind: "approval",
  payload,
});
export const lifecycle = (payload: Payload<"lifecycle">): WireEvent => ({
  kind: "lifecycle",
  payload,
});

export async function captureWorkerTranscriptSource(target: SessionTranscriptRuntimeTarget) {
  const entry = loadSessionEntry(target);
  if (!entry || entry.sessionId !== target.sessionId) {
    throw new Error("expected admitted worker session");
  }
  const sessionTarget = {
    ...captureSessionTranscriptTargetBinding(target),
    expectedLifecycleRevision: entry.lifecycleRevision,
    expectedWriterRunId: entry.activeWriterRunId,
  };
  const authority = await prepareWorkerTurnTranscriptSource(sessionTarget);
  return { sessionTarget, receiptAuthority: authority, release: () => authority.release() };
}

export function holdWorkerTranscriptWriter(storePath: string) {
  const entered = createDeferredCore();
  const release = createDeferredCore();
  const done = runOpenClawAgentWorkerWrite(
    toDatabaseOptions(resolveSqliteReadScope({ agentId: "main", storePath })),
    async () => {
      entered.resolve();
      await release.promise;
    },
  );
  return { entered: entered.promise, release: release.resolve, done };
}

export async function seedWorkerLiveSession(storePath: string, n: number, updatedAt = 20) {
  const target = {
    agentId: "main",
    sessionId: `session-farm-${n}`,
    sessionKey: `agent:main:farm-${n}`,
    storePath,
  };
  await upsertSessionEntryCore(target, {
    sessionId: target.sessionId,
    updatedAt,
    lifecycleRevision: `farm-lifecycle-${n}-${updatedAt}`,
    activeWriterRunId: `run-farm-${n}`,
  });
  return captureWorkerTranscriptSource(target);
}

export const farmEvent = (n: number, seq: number, event: Params["event"]): Params =>
  live(seq, event, `run-farm-${n}`);
