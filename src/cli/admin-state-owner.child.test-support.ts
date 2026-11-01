import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import * as json5 from "json5";
import { registerSealedRuntime } from "../infra/sealed-runtime-registry.js";
import { withConsoleLogsRoutedToStderrForJson } from "./json-output-mode.js";
import { runCliWithExitFinalization } from "./one-shot-exit.js";
import { installCliSignalExitHandlers } from "./signal-exit-barrier.js";

const control = path.join(process.env.OPENCLAW_HOME!, "control");
fs.mkdirSync(control, { recursive: true });
registerSealedRuntime({ json5, resolveSecureTempRoot: () => control });
installCliSignalExitHandlers();
try {
  await runCliWithExitFinalization({
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
