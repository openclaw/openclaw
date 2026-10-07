import type { WorkerTranscriptMessage } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { makeTextToolResult } from "../../../test/helpers/text-tool-result.js";
import { createZeroUsageFixture } from "../../agents/test-helpers/usage-fixtures.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { WorkerConnectionIdentity } from "./connection-identity.js";
import type { WorkerTranscriptCommitStore } from "./transcript-commit-ledger.js";
import { createWorkerTranscriptCommitter } from "./transcript-commit.js";

export function createTranscriptCommitIdentity(
  sessionId: string,
  ownerEpoch: number,
): WorkerConnectionIdentity {
  return {
    environmentId: "environment-a",
    credentialHash: ["credential", "hash", "a"].join("-"),
    bundleHash: "b".repeat(64),
    sessionId,
    runId: "run-worker-transcript",
    turnClaim: {
      sessionId,
      claimId: "claim-worker-transcript",
      runId: "run-worker-transcript",
      placementGeneration: 4,
      owner: { kind: "worker", environmentId: "environment-a", ownerEpoch },
    },
    ownerEpoch,
    rpcSetVersion: 1,
    protocolFeatures: ["worker-transcript-commit-v1"],
    credentialExpiresAtMs: 10_000,
  };
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
export const PROVIDER_REPLAY = {
  v: 1 as const,
  type: "openai-responses-compaction",
  id: "cmp_worker_commit",
  data: "opaque-worker-commit",
  replayIndex: 1,
  provider: "openai",
  api: "openai-responses",
  model: "gpt-5.5",
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
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.5",
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
