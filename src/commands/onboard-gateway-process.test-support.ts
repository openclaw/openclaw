import assert from "node:assert/strict";
import {
  installCliSignalExitHandlers,
  registerSignalExitGate,
  waitForCliSignalExit,
} from "../cli/signal-exit-barrier.js";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
} from "../infra/database-engine/admission-scope.js";

const [entry, rawPort] = process.argv.slice(2);
assert(entry && rawPort, "Gateway handoff fixture needs the built CLI entry and port");
const port = Number(rawPort);
assert(Number.isInteger(port) && port > 0, "Gateway handoff fixture needs a valid port");
// Resolve the child from the isolated built package, while this parent remains a CLI one-shot.
process.argv = [process.execPath, entry, "onboard"];
installDatabaseProcessRole("cli-oneshot");
installCliSignalExitHandlers();
const { prepareCliDatabaseEngine } = await import("../cli/database-engine-selection.js");
await prepareCliDatabaseEngine(process.argv);
assertEngineStoreExecutionAllowed();

const [{ startOnboardingGatewayProcess }, { waitForGatewayReachable }] = await Promise.all([
  import("./onboard-gateway-process.js"),
  import("./onboard-helpers.js"),
]);
const gateway = await startOnboardingGatewayProcess({ port });
// The real CLI also holds a gate until the foreground command has finished.
const releaseCommandGate = registerSignalExitGate(gateway.wait.catch(() => {}));
try {
  const reachable = await Promise.race([
    gateway.wait.then(() => {
      throw new Error("Gateway exited before authenticated readiness");
    }),
    waitForGatewayReachable({
      url: `ws://127.0.0.1:${port}`,
      token: "synthetic-interactive-gateway-token",
      deadlineMs: 45_000,
      probeTimeoutMs: 10_000,
    }),
  ]);
  assert(reachable.ok, reachable.detail ?? "Gateway readiness probe failed");
  process.stdout.write("Onboarding child authenticated and ready\n");
  await gateway.wait;
} finally {
  await gateway.close();
  releaseCommandGate();
}
assertEngineStoreExecutionAllowed();
process.stdout.write("Onboarding parent retained its CLI role after child shutdown\n");
process.exitCode = await waitForCliSignalExit();
