import { flushCompileCache } from "node:module";
import "./worker-deploy-runtime.js";
import { formatCliOperatorError } from "../cli/failure-output.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { drainProcessOutput } from "../process/output-drain.js";
import workerDeployBrowserRuntime from "./worker-deploy-browser-runtime.js";
import { runWorkerProcess } from "./worker-process.js";
import { loadWorkerTurnRuntime } from "./worker.runtime.js";

try {
  await assertSupportedRuntime();

  const args = process.argv.slice(2);
  const internalWorkerIpc = args.includes("--internal-worker-ipc");
  const internalWorkerPrewarm = args.includes("--internal-worker-prewarm");
  const managed = args.includes("--internal-worker-session");
  const nativeInference = args.includes("--internal-worker-native-inference");
  if (
    new Set(args).size !== args.length ||
    args.some(
      (arg) =>
        ![
          "--internal-worker-ipc",
          "--internal-worker-prewarm",
          "--internal-worker-session",
          "--internal-worker-native-inference",
        ].includes(arg),
    ) ||
    (internalWorkerPrewarm && args.length !== 1) ||
    (nativeInference && !managed)
  ) {
    throw new Error("worker deploy entry received unsupported arguments");
  }

  if (internalWorkerPrewarm) {
    await loadWorkerTurnRuntime();
    flushCompileCache();
  } else {
    await runWorkerProcess({
      internalWorkerIpc,
      managed,
      browserRuntime: workerDeployBrowserRuntime,
    });
  }
} catch (error) {
  process.stderr.write(`${formatCliOperatorError(error)}\n`);
  process.exitCode = 1;
  drainProcessOutput(() => process.exit(1));
}
