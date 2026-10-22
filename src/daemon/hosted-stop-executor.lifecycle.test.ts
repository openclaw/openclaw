import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../shared/deferred.js";
import { prepareHostedStopExecutor } from "./hosted-stop-executor.js";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
const cleanups: (() => void)[] = [];
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  spawn.mockReset();
});

function executorChild(verifyPlacement?: (pid: number) => Promise<void>) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    // Signalling deliberately does not deliver close; the OS owns completion.
    kill: vi.fn(() => true),
  });
  spawn.mockReturnValueOnce(child);
  const close = () => {
    child.signalCode = "SIGKILL";
    child.emit("close", null, "SIGKILL");
  };
  cleanups.push(close);
  const abort = new AbortController();
  const preparation = prepareHostedStopExecutor({
    command: ["native-stop"],
    env: {},
    signal: abort.signal,
    assertCurrent: () => {},
    verifyPlacement,
  });
  const failed = vi.fn((error: unknown) => error);
  return { child, close, abort, preparation, failed, failure: preparation.catch(failed) };
}

it.each(["abort", "spawn error"])("joins close after preparation %s", async (fault) => {
  const { child, close, abort, failed, failure } = executorChild();
  if (fault === "abort") {
    abort.abort();
  } else {
    child.emit("error", new Error("native spawn failed"));
  }
  await Promise.resolve();
  expect(failed).not.toHaveBeenCalled();
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  close();
  expect(await failure).toBeInstanceOf(Error);
});

it("joins both cancelled placement discovery and the original child close", async () => {
  const placement = createDeferredCore();
  const inspecting = createDeferredCore();
  const { child, close, abort, failed, failure } = executorChild(() => {
    inspecting.resolve();
    return placement.promise;
  });
  child.stdout.write("123\n");
  await inspecting.promise;
  abort.abort();
  close();
  await Promise.resolve();
  expect(failed).not.toHaveBeenCalled();
  placement.resolve();
  expect(await failure).toBeInstanceOf(Error);
});

it("fences a committed executor but joins close before retirement", async () => {
  const { child, close, preparation } = executorChild();
  child.stdout.write("123\n");
  const executor = await preparation;
  const nativeResult = executor.execute(() => {});
  const retired = vi.fn();
  const retirement = executor.dispose().then(retired);
  expect(() => executor.execute(() => {})).toThrow("no longer available");
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
  await Promise.resolve();
  expect(retired).not.toHaveBeenCalled();
  close();
  await retirement;
  await expect(nativeResult).resolves.toMatchObject({ disposition: "uncertain" });
});
