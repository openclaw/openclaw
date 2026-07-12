import { parentPort, workerData } from "node:worker_threads";
import { reconcileSessionTranscriptIndexes } from "./session-transcript-reconcile.js";

type WorkerInput = { agentId: string; stateDir: string };
const input = workerData as Partial<WorkerInput> | undefined;
if (!parentPort || typeof input?.agentId !== "string" || typeof input.stateDir !== "string") {
  throw new Error("session transcript reconcile worker requires agentId and stateDir");
}
const sendToParent: (message: { status: string; error?: string }) => void =
  parentPort.postMessage.bind(parentPort);

try {
  sendToParent({ status: "ready" });
  await reconcileSessionTranscriptIndexes({
    agentId: input.agentId,
    stateDir: input.stateDir,
    onPlanning: () => {
      sendToParent({ status: "ready" });
    },
    onProgress: () => {
      sendToParent({ status: "progress" });
    },
    onRebuildActive: () => {
      sendToParent({ status: "started" });
    },
  });
  sendToParent({ status: "ok" });
} catch (error) {
  sendToParent({
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
