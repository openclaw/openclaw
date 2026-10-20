import { spawnSync } from "node:child_process";
import { accessSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  classifyChildRuntimeFailure,
  formatChildRuntimeSpawnWarning,
  formatMissingChildRuntimeWarning,
  readChildRuntimeViability,
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

describe("child runtime viability", () => {
  it.each([
    { path: "/missing-user-command", code: "ENOENT" },
    { path: process.execPath, code: "ENOENT" },
    { path: process.execPath, code: "EACCES" },
  ])("does not mislabel a command, cwd, or permission failure: $path $code", (fields) => {
    expect(
      formatChildRuntimeSpawnWarning(Object.assign(new Error("spawn failed"), fields)),
    ).toBeUndefined();
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
    expect(formatMissingChildRuntimeWarning(viability)).toBe(
      available
        ? undefined
        : `The Node.js runtime this Gateway started with (${removedCellarPath}) can no longer start worker processes, likely because it was upgraded or removed. Restart the Gateway.`,
    );
  });
});

it("records a permanent loader failure once and does not confuse a post-handshake crash", () => {
  const execPath = "/fixture/permanently-unavailable-node";
  log.error.mockClear();
  expect(
    classifyChildRuntimeFailure({
      execPath,
      started: true,
      stderr: "dyld[123]: Library not loaded: /fixture/lib.dylib",
    }),
  ).toBeUndefined();
  const failure = classifyChildRuntimeFailure({
    execPath,
    stderr: "dyld[123]: Library not loaded: /fixture/lib.dylib",
  });
  expect(failure).toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
  expect(classifyChildRuntimeFailure({ execPath, signal: "SIGABRT" })).toBe(failure);
  expect(readChildRuntimeViability({ execPath }).available).toBe(false);
  expect(log.error).toHaveBeenCalledExactlyOnceWith(failure?.message);
});

it("does not latch an unchanged runtime when both worker and diagnostic probe abort", () => {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 123,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGABRT",
  });
  expect(classifyChildRuntimeFailure({ signal: "SIGABRT" })).toBeUndefined();
  expect(readChildRuntimeViability().available).toBe(true);
});

it.each([false, true])(
  "confirms a pre-handshake IPC failure with the runtime probe (broken: %s)",
  (broken) => {
    const directory = mkdtempSync(path.join(tmpdir(), "openclaw-runtime-probe-"));
    const execPath = path.join(directory, "node");
    writeFileSync(execPath, "fixture", { mode: 0o700 });
    vi.mocked(spawnSync).mockReturnValueOnce({
      pid: 123,
      output: [null, "", ""],
      stdout: broken ? "" : "v26.12.0",
      stderr: broken ? "node: error while loading shared libraries: libnode.so" : "",
      status: broken ? 127 : 0,
      signal: null,
    });
    try {
      const failure = classifyChildRuntimeFailure({
        execPath,
        error: new Error("Child process IPC channel is closed"),
        signal: "SIGKILL",
      });
      if (broken) {
        expect(failure).toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
      } else {
        expect(failure).toBeUndefined();
      }
      expect(readChildRuntimeViability({ execPath }).available).toBe(!broken);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

it("classifies an executable changed since startup when its bare runtime also aborts", () => {
  vi.mocked(spawnSync).mockReturnValueOnce({
    pid: 123,
    output: [null, "", ""],
    stdout: "",
    stderr: "",
    status: null,
    signal: "SIGABRT",
  });
  expect(
    classifyChildRuntimeFailure({
      execPath: "/fixture/replaced-node",
      signal: "SIGABRT",
    }),
  ).toMatchObject({ code: "NODE_RUNTIME_UNAVAILABLE" });
});
