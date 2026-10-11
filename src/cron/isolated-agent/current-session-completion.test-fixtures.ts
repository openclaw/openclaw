import fs from "node:fs/promises";
import path from "node:path";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import {
  loadSessionEntryReadOnly,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../../config/sessions/session-accessor.js";
import { readTranscriptEventMessage } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX,
  resolveManagedOutgoingMediaArtifactDownload,
} from "../../gateway/managed-image-attachments.js";
import { listManagedImageRecordEntries } from "../../gateway/managed-image-record-store.js";
import { managedImageRecordOperations } from "../../gateway/managed-image-record-store.kernel.js";
import { onSessionTranscriptUpdate } from "../../sessions/transcript-events.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { commitCronConversationResult } from "../conversation-result.js";
import { resolveCronDeliveryPlan } from "../delivery-plan.js";
import { makeCronJob } from "../delivery.test-helpers.js";
import { createCliDeps } from "../isolated-agent.delivery.test-helpers.js";
import type { CronStoredJob } from "../types.js";
import type { DispatchCronDeliveryParams } from "./delivery-dispatch-types.js";

export const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZQmcAAAAASUVORK5CYII=",
  "base64",
);

export async function createCompletionFixture(
  state: OpenClawTestState,
  sessionTarget: "current" | "isolated" = "current",
  sessionKey = "agent:main:webchat:direct:report",
) {
  const sessionId = "report-session";
  const scope = {
    agentId: "main",
    sessionKey,
    sessionId,
    storePath: path.join(state.stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  const generation = { sessionId, lifecycleRevision: "report-generation" };
  await replaceSessionEntry(scope, { ...generation, updatedAt: 1 });
  await fs.mkdir(state.workspaceDir, { recursive: true });
  const imagePath = path.join(state.workspaceDir, "report.png");
  await fs.writeFile(imagePath, PNG);
  const cfg = {
    agents: { entries: { main: { workspace: state.workspaceDir } } },
    session: { store: scope.storePath },
  };
  const payload: ReplyPayload = { text: "Example report", mediaUrl: imagePath };
  const job: CronStoredJob = {
    ...makeCronJob({ id: "report-job", sessionTarget, sessionKey }),
    ...(sessionTarget === "isolated"
      ? {
          sourceConversation: { sessionKey, ...generation },
          delivery: { mode: "announce", channel: "last" },
        }
      : {}),
  };
  const params: DispatchCronDeliveryParams = {
    deliveryAttemptFence: null,
    cfgWithAgentDefaults: cfg,
    deps: createCliDeps(),
    job,
    agentId: "main",
    agentSessionKey: "agent:main:cron:report-job",
    sourceSessionKey: sessionKey,
    sourceSessionGeneration: generation,
    runSessionKey: "agent:main:cron:report-job:run:report-run",
    sessionId: "report-run",
    lifecycleRevision: "run-generation",
    sessionUpdatedAt: 1000,
    runStartedAt: 1000,
    timeoutMs: 30000,
    resolvedDelivery: { ok: false, mode: "implicit", error: new Error("No external channel") },
    deliveryPlan: resolveCronDeliveryPlan(job),
    deliveryRequested: true,
    undeliveredRunStatus: "ok",
    spawnOnlyHandoff: false,
    sourceDeliveryOutcome: {
      visibleDeliveries: [],
      verifiedMessageToolDelivery: false,
      satisfiesSourceDelivery: false,
      unverifiedMessageToolDelivery: false,
    },
    deliveryBestEffort: false,
    deliveryPayloads: [payload],
    isAborted: () => false,
    abortReason: () => "aborted",
  };
  const records = () => listManagedImageRecordEntries({ stateDir: state.stateDir, sessionKey });
  const database = openOpenClawStateDatabase({ env: state.env });
  const downloads: Array<ReturnType<typeof resolveManagedOutgoingMediaArtifactDownload>> = [];
  const readDownloads = async () =>
    (await Promise.allSettled(downloads)).map((result) => {
      if (result.status === "rejected") {
        throw result.reason;
      }
      return result.value;
    });
  let updates = 0;
  const unsubscribe = onSessionTranscriptUpdate((update) => {
    if (update.target.sessionId !== sessionId) {
      return;
    }
    updates += 1;
    // Observe records at publication, before a wrongly late write could make the test pass.
    const entries = managedImageRecordOperations["managedImages.entries"](
      { sessionKey },
      { open: () => database, stateOptions: () => ({ path: database.path, env: state.env }) },
    );
    for (const { record } of entries) {
      const pending = resolveManagedOutgoingMediaArtifactDownload({
        sessionKey,
        agentId: "main",
        stateDir: state.stateDir,
        artifactId: `${MANAGED_OUTGOING_IMAGE_ARTIFACT_ID_PREFIX}${record.attachmentId}`,
      });
      void pending.catch(() => {});
      downloads.push(pending);
    }
  });
  return {
    payload,
    job,
    params,
    scope,
    records,
    downloads: readDownloads,
    updates: () => updates,
    dispose: async () => {
      unsubscribe();
      await readDownloads();
    },
    commit: () =>
      commitCronConversationResult({
        config: params.cfgWithAgentDefaults,
        agentId: params.agentId,
        jobId: params.job.id,
        runStartedAt: params.runStartedAt,
        conversation: { sessionKey, ...generation },
        payloads: params.deliveryPayloads,
        text: params.synthesizedText,
        signal: params.abortSignal,
        deliveryAttemptFence: params.deliveryAttemptFence,
      }),
    messages: async () =>
      (await loadTranscriptEvents(scope)).filter(
        (event) => readTranscriptEventMessage(event)?.role === "assistant",
      ),
  };
}

export async function readConversationMessages(scope: {
  agentId: string;
  sessionKey: string;
  storePath: string;
}) {
  const entry = loadSessionEntryReadOnly({ ...scope, readConsistency: "latest" });
  if (!entry) {
    throw new Error(`Missing conversation: ${scope.sessionKey}`);
  }
  return (await loadTranscriptEvents({ ...scope, sessionId: entry.sessionId })).filter(
    (event) => readTranscriptEventMessage(event)?.role === "assistant",
  );
}
