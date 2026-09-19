#!/usr/bin/env node
// Sealed CLI composition root for the private macOS app node-host worker.
import process from "node:process";
import { fileURLToPath } from "node:url";
import { ensureCliExecutionBootstrap } from "../cli/command-execution-startup.js";
import { resolveCliStartupPolicy } from "../cli/command-startup-policy.js";
import { loadCliDotEnv } from "../cli/dotenv.js";
import { withConsoleLogsRoutedToStderrForJson } from "../cli/json-output-mode.js";
import { applyCliProfileEnv, parseCliProfileArgs } from "../cli/profile.js";
import { normalizeEnv } from "../infra/env.js";
import { isMainModule } from "../infra/is-main.js";
import { ensureOpenClawExecMarkerOnProcess } from "../infra/openclaw-exec-env.js";
import { assertSupportedRuntime } from "../infra/runtime-guard.js";
import { installProcessWarningFilter } from "../infra/warning-filter.js";
import { enableConsoleCapture } from "../logging.js";
import { defaultRuntime } from "../runtime.js";
import { runNodeHostWorker } from "./worker.js";

const COMMAND_PATH = ["node", "worker"] as const;

export function resolveMacNodeWorkerArgv(
  argv: string[],
): { ok: true; argv: string[]; profile: string | null } | { ok: false; error: string } {
  const parsed = parseCliProfileArgs(argv);
  if (!parsed.ok) {
    return parsed;
  }
  const command = parsed.argv.slice(2);
  if (
    command.length !== COMMAND_PATH.length ||
    command.some((value, index) => value !== COMMAND_PATH[index])
  ) {
    return { ok: false, error: "Private macOS worker accepts only: node worker" };
  }
  return { ok: true, argv: parsed.argv, profile: parsed.profile };
}

async function runMacNodeWorkerEntry(argv: string[] = process.argv): Promise<void> {
  const parsed = resolveMacNodeWorkerArgv(argv);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }
  process.title = "openclaw-node-worker";
  ensureOpenClawExecMarkerOnProcess();
  installProcessWarningFilter();
  normalizeEnv();
  if (parsed.profile) {
    applyCliProfileEnv({ profile: parsed.profile });
  }
  loadCliDotEnv({ quiet: true });
  enableConsoleCapture();
  await assertSupportedRuntime(undefined, undefined, parsed.argv, true, { ...process.env });
  const startupPolicy = resolveCliStartupPolicy({
    argv: parsed.argv,
    commandPath: [...COMMAND_PATH],
    jsonOutputMode: false,
    machineOutputMode: true,
  });
  await withConsoleLogsRoutedToStderrForJson(
    parsed.argv,
    async () => {
      await ensureCliExecutionBootstrap({
        runtime: defaultRuntime,
        commandPath: [...COMMAND_PATH],
        startupPolicy,
      });
      await runNodeHostWorker();
    },
    { machineOutput: true, retainRoutingUntilProcessExit: true },
  );
}

if (isMainModule({ currentFile: fileURLToPath(import.meta.url) })) {
  await runMacNodeWorkerEntry().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
