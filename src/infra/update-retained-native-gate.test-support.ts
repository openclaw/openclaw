import { randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect } from "vitest";
import { UPDATE_NATIVE_GATE_SOURCE } from "../cli/update-cli/update-command-native-gate.generated.js";
import { prepareUpdateCommandNativeGate } from "../cli/update-cli/update-command-native-gate.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";

/** Install the helper that replacement removes; entrypointsUrl names it for the fixture. */
export async function stageLiveNativeGate(root: string) {
  const liveEntry = path.join(root, "dist/cli/update-cli/update-command-native-gate.worker.js");
  await mkdir(path.dirname(liveEntry), { recursive: true });
  await writeFile(liveEntry, UPDATE_NATIVE_GATE_SOURCE);
  const entrypoints = path.join(root, "dist/infra/runtime-process-entrypoints.js");
  return { liveEntry, entrypointsUrl: pathToFileURL(entrypoints).href };
}

export async function expectRetainedNativeGate(liveEntry: string) {
  await rm(liveEntry);
  const gate = prepareUpdateCommandNativeGate(randomUUID(), [process.env]);
  const result = await runUtf8CommandWithTimeout(
    [...gate.argv, process.execPath, "-e", 'process.stdout.write("retained native gate")'],
    { input: gate.input, baseEnv: {}, env: gate.env, timeoutMs: 10_000, killProcessTree: true },
  );
  expect(result.code, result.stderr).toBe(0);
  expect(result.stdout).toBe("retained native gate");
}
