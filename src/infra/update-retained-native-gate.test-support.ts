import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { expect } from "vitest";
import { prepareUpdateCommandNativeGate } from "../cli/update-cli/update-command-native-gate.js";
import { runUtf8CommandWithTimeout } from "../process/exec.js";

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
