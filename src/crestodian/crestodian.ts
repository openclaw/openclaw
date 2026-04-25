import { stdin as defaultStdin, stdout as defaultStdout } from "node:process";
import { defaultRuntime, writeRuntimeJson, type RuntimeEnv } from "../runtime.js";
import type { CrestodianAssistantPlanner } from "./assistant.js";
import { resolveCrestodianOperation } from "./dialogue.js";
import {
  executeCrestodianOperation,
  isPersistentCrestodianOperation,
  type CrestodianCommandDeps,
} from "./operations.js";
import { formatCrestodianOverview, loadCrestodianOverview } from "./overview.js";
import { runCrestodianTui } from "./tui-backend.js";

export type RunCrestodianOptions = {
  message?: string;
  yes?: boolean;
  json?: boolean;
  interactive?: boolean;
  deps?: CrestodianCommandDeps;
  planWithAssistant?: CrestodianAssistantPlanner;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  runInteractiveTui?: typeof runCrestodianTui;
};

async function runOneShot(
  input: string,
  runtime: RuntimeEnv,
  opts: RunCrestodianOptions,
): Promise<void> {
  const operation = await resolveCrestodianOperation(input, runtime, opts);
  await executeCrestodianOperation(operation, runtime, {
    approved: opts.yes === true || !isPersistentCrestodianOperation(operation),
    deps: opts.deps,
  });
}

export async function runCrestodian(
  opts: RunCrestodianOptions = {},
  runtime: RuntimeEnv = defaultRuntime,
): Promise<void> {
  if (opts.json) {
    const overview = await loadCrestodianOverview();
    writeRuntimeJson(runtime, overview);
    return;
  }

  if (opts.message?.trim()) {
    const overview = await loadCrestodianOverview();
    runtime.log(formatCrestodianOverview(overview));
    runtime.log("");
    await runOneShot(opts.message, runtime, opts);
    return;
  }

  const interactive = opts.interactive ?? true;
  const input = opts.input ?? defaultStdin;
  const output = opts.output ?? defaultStdout;
  const inputIsTty = (input as { isTTY?: boolean }).isTTY === true;
  const outputIsTty = (output as { isTTY?: boolean }).isTTY === true;
  if (!interactive || !inputIsTty || !outputIsTty) {
    runtime.error("Crestodian needs an interactive TTY. Use --message for one command.");
    return;
  }

  const runInteractiveTui = opts.runInteractiveTui ?? runCrestodianTui;
  await runInteractiveTui(opts, runtime);
}
