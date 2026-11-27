import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { once } from "node:events";
import { accessSync, writeFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  classifyChildRuntimeFailure,
  formatChildRuntimeSpawnWarning,
  formatMissingChildRuntimeWarning,
  observeChildRuntime,
  readChildRuntimeViability,
  prepareChildRuntimeViability,
} from "./child-runtime-viability.ts";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawnSync: vi.fn(actual.spawnSync) };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, accessSync: vi.fn(actual.accessSync) };
});

const log = vi.hoisted(() => ({ error: vi.fn() }));
// mock-isolation: Capture this process-wide diagnosis without writing host logs.
vi.mock("../logging/subsystem.js", () => ({ createSubsystemLogger: () => log }));

const removedCellarPath = "/opt/homebrew/Cellar/node@24/24.20.0/bin/node";
const directories = useAutoCleanupTempDirTracker(afterEach);
function mockProbe(overrides: Partial<SpawnSyncReturns<string>> = {}) {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 123,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGABRT",
    ...overrides,
  });
}

it.each([
  { path: "/missing-user-command", code: "ENOENT" },
  { path: process.execPath, code: "ENOENT" },
  { path: process.execPath, code: "EACCES" },
])("does not mislabel command/cwd/permission failures: $path $code", async (fields) => {
  const error = Object.assign(new Error("spawn failed"), fields);
  expect(await formatChildRuntimeSpawnWarning(error)).toBeUndefined();
});
it.each([
  { execPath: removedCellarPath, code: "ENOENT", available: false },
  { execPath: process.execPath, code: undefined, available: true },
  { execPath: "/fixture/restricted-node", code: "EACCES", available: true },
])("classifies executable access $code", ({ execPath, code, available }) => {
  vi.mocked(accessSync).mockImplementationOnce(() => {
    if (code) {
      throw Object.assign(new Error(code), { code });
    }
  });
  const viability = readChildRuntimeViability({ execPath });
  expect(viability).toEqual({ execPath, available });
  if (available) {
    expect(formatMissingChildRuntimeWarning(viability)).toBeUndefined();
  }
});

it("records a permanent loader failure once and does not confuse a post-handshake crash", () => {
  const execPath = "/fixture/permanently-unavailable-node";
  const input = { execPath, stderr: "dyld[123]: Library not loaded: /fixture/lib.dylib" };
  log.error.mockClear();
  expect(classifyChildRuntimeFailure({ ...input, started: true })).toBeUndefined();
  const failure = classifyChildRuntimeFailure(input);
  expect(failure).toHaveProperty("code", "NODE_RUNTIME_UNAVAILABLE");
  expect(failure?.message).toMatch(/Restart the Gateway\.\n.*Library not loaded/);
  expect(classifyChildRuntimeFailure({ execPath, signal: "SIGABRT" })).toBe(failure);
  expect(readChildRuntimeViability({ execPath }).available).toBe(false);
  expect(log.error).toHaveBeenCalledExactlyOnceWith(failure?.message);
});

it("preserves a library filename split across stderr writes", async () => {
  const library = "lib🧭.so";
  const first = Buffer.concat([
    Buffer.from("node: error while loading shared libraries: lib"),
    Buffer.from("🧭").subarray(0, 2),
  ]);
  const second = Buffer.concat([Buffer.from("🧭").subarray(2), Buffer.from(".so\n")]);
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        "const [first, second] = process.argv.slice(1);",
        "process.stderr.write(Buffer.from(first, 'base64'));",
        "process.stdin.once('data', () => {",
        "  process.stderr.write(Buffer.from(second, 'base64'));",
        "  process.exitCode = 127;",
        "});",
      ].join("\n"),
      first.toString("base64"),
      second.toString("base64"),
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  const diagnose = observeChildRuntime(child, "/fixture/split-stderr-node");
  // Wait until the first write is actually delivered before releasing the second.
  child.stderr.once("data", () => child.stdin.end("continue"));
  const [exitCode] = await once(child, "close");

  expect(exitCode).toBe(127);
  expect(await diagnose()).toMatchObject({
    code: "NODE_RUNTIME_UNAVAILABLE",
    message: expect.stringContaining(library),
  });
});

it.each([undefined, "/fixture/replaced-node"])(
  "latches only changed-runtime aborts: %s",
  (execPath) => {
    mockProbe();
    const failure = classifyChildRuntimeFailure({ execPath, signal: "SIGABRT" });
    expect(failure).toEqual(
      execPath ? expect.objectContaining({ code: "NODE_RUNTIME_UNAVAILABLE" }) : undefined,
    );
    expect(readChildRuntimeViability({ execPath }).available).toBe(!execPath);
  },
);

it.each([false, true])("probes pre-handshake IPC failures (broken: %s)", (broken) => {
  const directory = directories.make("openclaw-runtime-probe-");
  const execPath = path.join(directory, "node");
  writeFileSync(execPath, "fixture", { mode: 0o700 });
  mockProbe({
    stdout: broken ? "" : "v26.12.0",
    stderr: broken ? "node: error while loading shared libraries: libnode.so" : "",
    status: broken ? 127 : 0,
    signal: null,
  });
  const failure = classifyChildRuntimeFailure({
    execPath,
    error: new Error("Child process IPC channel is closed"),
    signal: "SIGKILL",
  });
  expect(failure).toEqual(
    broken ? expect.objectContaining({ code: "NODE_RUNTIME_UNAVAILABLE" }) : undefined,
  );
  expect(readChildRuntimeViability({ execPath }).available).toBe(!broken);
});

it("retains prepared refusals across other paths and honors a later same-path failure", async () => {
  const directory = directories.make("openclaw-runtime-publication-");
  const missing = path.join(directory, "missing");
  const refused = await prepareChildRuntimeViability({ execPath: missing });
  await prepareChildRuntimeViability({ execPath: path.join(directory, "other-missing") });
  expect(refused.publish()).toEqual({ execPath: missing, available: false });

  const executable = path.join(directory, "executable");
  writeFileSync(executable, "synthetic runtime", { mode: 0o700 });
  const prepared = await prepareChildRuntimeViability({ execPath: executable });
  expect(prepared.publish().available).toBe(true);
  await fs.unlink(executable);
  await prepareChildRuntimeViability({ execPath: executable });
  expect(prepared.publish()).toEqual({ execPath: executable, available: false });
});
