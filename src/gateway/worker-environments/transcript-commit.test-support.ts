import { createHash } from "node:crypto";
import type {
  WorkerTranscriptCommitParams,
  WorkerTranscriptMessage,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import { createWorkerConnectionIdentity } from "./connection-identity.test-support.js";
import type { WorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";

export function createTranscriptCommitIdentity(
  sessionId: string,
  ownerEpoch: number,
): WorkerConnectionIdentity {
  const turnClaim: NonNullable<WorkerConnectionIdentity["turnClaim"]> = {
    sessionId,
    claimId: "claim-worker-transcript",
    runId: "run-worker-transcript",
    placementGeneration: 4,
    owner: { kind: "worker", environmentId: "environment-a", ownerEpoch },
  };
  return createWorkerConnectionIdentity(turnClaim, {
    credentialHash: ["credential", "hash", "a"].join("-"),
    bundleHash: "b".repeat(64),
    protocolFeatures: ["worker-transcript-commit-v1"],
  });
}

export function createInterruptedCommitter(
  getConfig: () => OpenClawConfig,
  store: WorkerTranscriptCommitStore,
  message: string,
) {
  let interruptCompletion = true;
  return createWorkerTranscriptCommitter({
    getConfig,
    store: {
      ...store,
      complete: (input, assertCurrent) => {
        if (interruptCompletion) {
          interruptCompletion = false;
          throw new Error(message);
        }
        return store.complete(input, assertCurrent);
      },
    },
  });
}

export const ZERO_USAGE = createZeroUsageFixture();
const MODEL = { provider: "openai", api: "openai-responses", model: "gpt-5.5" };
export const PROVIDER_REPLAY = {
  v: 1 as const,
  type: "openai-responses-compaction",
  id: "cmp_worker_commit",
  data: "opaque-worker-commit",
  replayIndex: 1,
  ...MODEL,
  baseUrlHash: "ozhevd1smnk8s",
  sessionHash: "171dzdv17gum5g",
  authProfileHash: "oe8bkr3r8947",
};

export function createTurnMessages(userText = "Inspect the workspace"): WorkerTranscriptMessage[] {
  return [
    {
      role: "user",
      content: [{ type: "text", text: userText }],
      timestamp: 100,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "I will inspect it." },
        {
          type: "toolCall",
          id: "call-read-1",
          name: "read",
          arguments: { path: "README.md" },
        },
      ],
      ...MODEL,
      providerReplay: structuredClone(PROVIDER_REPLAY),
      diagnostics: [
        {
          type: "provider-warning",
          timestamp: 201,
          error: { name: "", message: "diagnostic", stack: "", code: 0 },
          details: { empty: "", enabled: false },
        },
      ],
      usage: ZERO_USAGE,
      stopReason: "toolUse",
      timestamp: 200,
    },
    makeTextToolResult("call-read-1", "read", "Workspace ready.", false, 300),
  ];
}

export const SESSION_ID = "session-worker-transcript";
export const RUN_EPOCH = 7;

export function createRequest(
  params: Partial<Pick<WorkerTranscriptCommitParams, "baseLeafId" | "messages" | "seq">> = {},
): WorkerTranscriptCommitParams {
  return {
    runEpoch: RUN_EPOCH,
    seq: params.seq ?? 1,
    baseLeafId: params.baseLeafId ?? null,
    messages: params.messages ?? createTurnMessages(),
  };
}

export function messageIdempotencyKey(seq: number, index: number): string {
  const digest = createHash("sha256")
    .update([SESSION_ID, RUN_EPOCH, seq, index].join("\0"))
    .digest("base64url");
  return `worker-commit-${digest}`;
}
