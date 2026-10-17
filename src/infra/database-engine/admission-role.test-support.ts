import { isMainThread, parentPort, workerData } from "node:worker_threads";
import {
  assertEngineStoreExecutionAllowed,
  installDatabaseProcessRole,
  type DatabaseProcessRole,
} from "./admission-scope.js";

function probe(role?: DatabaseProcessRole) {
  if (role) {
    installDatabaseProcessRole(role);
    installDatabaseProcessRole(role);
  }
  let allowed = false;
  try {
    assertEngineStoreExecutionAllowed();
    allowed = true;
  } catch {
    // Report refusal through the subprocess boundary.
  }
  let changeRefused = false;
  if (role) {
    try {
      installDatabaseProcessRole(role === "gateway" ? "cli-oneshot" : "gateway");
    } catch {
      changeRefused = true;
    }
  }
  return { allowed, changeRefused };
}

async function probeMain(role?: DatabaseProcessRole) {
  const result = probe(role);
  let gatewayRefused: boolean | undefined;
  if (role === "cli-oneshot") {
    const { startGatewayServer } = await import("../../gateway/server.js");
    try {
      await startGatewayServer();
      gatewayRefused = false;
    } catch (error) {
      gatewayRefused = error instanceof Error && error.message.includes("cannot become gateway");
    }
  }
  process.send?.({ ...result, ...(gatewayRefused === undefined ? {} : { gatewayRefused }) });
  process.disconnect?.();
}

if (isMainThread) {
  process.once("message", ({ role }: { role?: DatabaseProcessRole }) => {
    void probeMain(role);
  });
} else {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node MessagePort has no targetOrigin.
  parentPort?.postMessage(probe(workerData?.role));
}
