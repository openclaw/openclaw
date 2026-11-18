import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Command } from "commander";
import * as json5 from "json5";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { withRuntimeWorkerGeneration } from "../infra/runtime-worker-generation.js";
import { registerSealedRuntime } from "../infra/sealed-runtime-registry.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";
import { installCliSignalExitHandlers } from "./signal-exit-barrier.js";

const control = path.join(process.env.OPENCLAW_HOME!, "control");
fs.mkdirSync(control, { recursive: true });
registerSealedRuntime({ json5, resolveSecureTempRoot: () => control });
installCliSignalExitHandlers();
const run = () =>
  runCliWithExitFinalization({
    run: () =>
      withConsoleLogsRoutedToStderrForJson(
        process.argv,
        async () => {
          const program = new Command().name("openclaw").exitOverride();
          if (process.argv[2] === "pairing") {
            const { registerPairingCli } = await import("./pairing-cli.js");
            registerPairingCli(program);
          } else if (process.argv[2] === "secrets") {
            const { registerSecretStoreCli } = await import("./secrets-store-cli.js");
            registerSecretStoreCli(program.command("secrets"));
          } else if (process.argv[2] === "models") {
            const { modelsRefreshCommand } = await import("../commands/models/refresh.js");
            const { defaultRuntime } = await import("../runtime.js");
            program
              .command("models")
              .command("refresh")
              .action(() => modelsRefreshCommand({}, defaultRuntime));
          } else {
            const { registerExecApprovalsCli } = await import("./exec-approvals-cli.js");
            registerExecApprovalsCli(program);
          }
          await program.parseAsync(process.argv.slice(2), { from: "user" });
        },
        { retainRoutingUntilProcessExit: true },
      ),
    onError: (error) => {
      throw error;
    },
  });
try {
  const preload = process.env.OPENCLAW_TEST_SQLITE_WORKER_PRELOAD;
  if (preload) {
    await withRuntimeWorkerGeneration(
      async (bind) => {
        const workers = new Map<string, URL>();
        for (const name of [
          "sharedStateStore",
          "stateRead",
          "workerNativeLifecycle",
          "spawnBroker",
        ] as const) {
          const original = resolveRuntimeProcessEntrypointUrl(name);
          const extension = path.extname(original.pathname).endsWith("ts") ? ".mts" : ".mjs";
          const wrapper = pathToFileURL(path.join(control, `observed-${name}${extension}`));
          const load =
            name === "sharedStateStore"
              ? `export const { createSqliteWorkerBackend, openExistingSqliteWorkerBackend } = await import(${JSON.stringify(original.href)});`
              : `await import(${JSON.stringify(original.href)});`;
          fs.writeFileSync(wrapper, `await import(${JSON.stringify(preload)});\n${load}\n`);
          workers.set(original.href, wrapper);
        }
        // Carry the observation into real CLI workers through their existing source owner.
        bind((url) => workers.get(url.href) ?? url);
        await run();
      },
      async () => {},
    );
  } else {
    await run();
  }
} catch (error) {
  const { formatCliFailureLines } = await import("./failure-output.js");
  for (const line of formatCliFailureLines({
    title: "The CLI command failed.",
    error,
    argv: process.argv,
  })) {
    process.stderr.write(`${line}\n`);
  }
  process.exitCode = 1;
} finally {
  process.stdin.pause();
}
