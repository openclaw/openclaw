import { ChildProcess } from "node:child_process";
import path from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { launchCanary } from "./update-candidate-canary-process.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn<typeof import("node:child_process").spawn>() }));
// mock-isolation: observe native launch arguments without executing a real Gateway.
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

const root = path.resolve("canary-image");
beforeEach(() => {
  vi.stubGlobal("__openclawStandaloneRootUrl", pathToFileURL(root).href);
  mocks.spawn.mockImplementation(() => {
    const child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    queueMicrotask(() => {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

it("routes a worker target through the embedded entry dispatcher", async () => {
  const entry = path.join(root, "dist/infra/update-migrated-finalize.worker.js");
  const running = launchCanary({
    target: { kind: "worker", url: pathToFileURL(entry) },
    args: ["--check"],
    root,
    env: {},
    stateDir: root,
    capture() {},
  });
  await running.closed;
  expect(await running.result).toBe(0);
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
    process.execPath,
    [...(process.versions.bun ? ["--no-install"] : []), entry, "--check"],
    expect.objectContaining({ cwd: root }),
  );
});

it("routes a CLI target through the standalone command entry", async () => {
  const running = launchCanary({
    target: { kind: "cli", entryPath: path.join(root, "dist/index.js") },
    args: ["gateway", "run"],
    root,
    env: {},
    stateDir: root,
    capture() {},
  });
  await running.closed;
  expect(await running.result).toBe(0);
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
    process.execPath,
    ["gateway", "run"],
    expect.objectContaining({ cwd: root }),
  );
});

it("keeps each pipe's pending-character bound, omission order, and final fragment", async () => {
  const boundary = "🦊".repeat(32_768);
  const completed = "w".repeat(65_537);
  mocks.spawn.mockImplementationOnce(() => {
    const child = Object.assign(new ChildProcess(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    });
    queueMicrotask(() => {
      for (const stream of [child.stdout, child.stderr]) {
        stream.write(boundary);
        stream.write("\r\n");
        stream.write(`${completed}\n`);
        stream.write("x".repeat(65_537));
        stream.write("synthetic-sensitive-suffix");
        stream.write("\nsafe\r\nprivate-receipt\nfinal\r");
      }
      child.emit("close", 0, null);
    });
    return child;
  });
  const captured: string[] = [];
  const observed: string[] = [];
  const running = launchCanary({
    target: { kind: "cli", entryPath: path.join(root, "dist/index.js") },
    args: [],
    root,
    env: {},
    stateDir: root,
    capture: (line) => captured.push(line),
    hidesLine: (line) => line === "private-receipt",
    onLine: (line) => observed.push(line),
  });
  await running.closed;
  const capturedPipe = [boundary, completed, "[oversized log line omitted]", "safe"];
  const observedPipe = [boundary, completed, "safe", "private-receipt"];
  expect(captured).toEqual([...capturedPipe, ...capturedPipe, "final\r", "final\r"]);
  expect(observed).toEqual([...observedPipe, ...observedPipe, "final\r", "final\r"]);
});
