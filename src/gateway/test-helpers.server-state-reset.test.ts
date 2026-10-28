import { afterEach, it } from "vitest";
import { recordPersistedContextEngineQuarantine } from "../context-engine/quarantine-health.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { installGatewayTestHooks } from "./test-helpers.server.js";

// Registered before the Gateway hooks, so Vitest's stacked afterEach order runs
// this after the case has closed its databases and before the next case resets.
let lateRead = false;
afterEach(() => {
  if (lateRead) {
    lateRead = false;
    // Models the post-restore subagent sweep timer: it outlives a closed Gateway
    // and captures the shared-state database the fixture is about to delete.
    captureOpenClawStateWorkerContext();
  }
});
installGatewayTestHooks({ scope: "suite", prepareServer: false });

const quarantine = (engineId: string) =>
  recordPersistedContextEngineQuarantine({
    engineId,
    operation: "resolve",
    reason: "fixture",
    failedAt: new Date(1),
  });

it("leaves a late reader admitted after the case closes its state", async () => {
  await quarantine("state-reset-first");
  lateRead = true;
});

it("creates the next case's state database through a worker binding", async () => {
  await quarantine("state-reset-second");
});
