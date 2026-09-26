import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { PtyRun } from "./tui-pty-test-support.js";

const scope = vi.hoisted(() => ({ root: "" }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    // Even allocation before owner admission stays inside this private probe.
    mkdtemp: (prefix: string) => actual.mkdtemp(path.join(scope.root, path.basename(prefix))),
    writeFile: vi.fn(actual.writeFile),
  };
});
vi.mock("esbuild", () => ({
  transform: () => {
    throw new Error("Lifecycle controls must not compile a fixture");
  },
}));
vi.mock("../infra/runtime-worker-url.js", () => ({
  resolveRuntimeWorkerUrl: () => new URL("file:///fixture/runtime.ts"),
  resolveRuntimeWorkerArgv: () => ["fixture-script"],
}));
vi.mock("./tui-pty-test-support.js", () => ({
  startRuntimePty: vi.fn(),
  waitFor: vi.fn(),
}));
vi.mock("./tui-pty-harness-assertion-test-support.js", () => ({
  waitForFixtureLogEntry: vi.fn(),
  readFixtureLog: vi.fn(),
  waitForSynchronizedFrameRows: vi.fn(),
  hasHistoricalSynchronizedFrameRow: vi.fn(),
}));
vi.mock("../../test/helpers/fixture-lifetime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../test/helpers/fixture-lifetime.js")>();
  // Only the claim namespace is substituted; the real acquisition/drain owner runs.
  return { ...actual, createFixtureLifetime: () => actual.createFixtureLifetime(scope.root) };
});

type FixtureApi = typeof import("./tui-pty-harness-fixture-test-support.js");
type Outcome<T> = { status: "fulfilled"; value: T } | { status: "rejected"; reason: unknown };
const tempDirs = createTempDirTracker();
const bodies: Promise<unknown>[] = [];
const observations: Promise<unknown>[] = [];
const releases: Array<() => void> = [];
let owner: ReturnType<typeof createVitestResourceOwner>;
let subject: FixtureApi | undefined;
let launch = vi.fn<typeof import("./tui-pty-test-support.js").startRuntimePty>();
let write = vi.fn<typeof fs.promises.writeFile>();
let intentionalRetention = false;

function makeOwner() {
  const next = createVitestResourceOwner(tempDirs.make("tui-pty-fixture-owner-"));
  scope.root = next.root;
  return next;
}

function own(body: () => Promise<void>) {
  const completion = Promise.resolve().then(body);
  bodies.push(completion);
  return completion;
}

function hold() {
  const gate = createDeferred();
  releases.push(() => gate.resolve());
  return gate;
}

function observe<T>(promise: Promise<T>) {
  let settled = false;
  const outcome: Promise<Outcome<T>> = promise.then(
    (value): Outcome<T> => {
      settled = true;
      return { status: "fulfilled", value };
    },
    (reason: unknown): Outcome<T> => {
      settled = true;
      return { status: "rejected", reason };
    },
  );
  observations.push(outcome);
  return { outcome, settled: () => settled };
}

function rejected(result: Outcome<unknown>) {
  if (result.status !== "rejected") {
    throw new Error("Expected fixture promise to reject");
  }
  return result.reason;
}

function makeRun(dispose: () => Promise<void> = async () => {}): PtyRun {
  return {
    cols: 80,
    rows: 24,
    pid: 123,
    output: () => "",
    visibleOutput: () => "",
    write: async () => {},
    waitForOutput: async () => "",
    waitForExit: async () => ({ exitCode: 0, signal: 0 }),
    forceKill: async () => {},
    dispose,
  };
}

const reached = (promise: Promise<unknown>, label: string) =>
  withTestTimeout(promise, 1_000, label);
// Expose early public settlement while an explicit gate remains held; this is not a drain.
const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

beforeEach(async () => {
  // Failed claims are intentional private probes, never reusable module state.
  vi.resetModules();
  subject = undefined;
  intentionalRetention = false;
  owner = makeOwner();
  launch = vi.mocked((await import("./tui-pty-test-support.js")).startRuntimePty);
  launch.mockReset();
  write = vi.mocked((await import("node:fs/promises")).writeFile);
  write.mockReset().mockImplementation(fs.promises.writeFile);
  subject = await import("./tui-pty-harness-fixture-test-support.js");
});

afterEach(async () => {
  // A timed-out test can still own its callback. Release gates, then join that body
  // and every observed operation before removing the private probe namespace.
  for (const release of releases.splice(0)) {
    release();
  }
  await Promise.allSettled(bodies.splice(0));
  await Promise.allSettled(observations.splice(0));
  try {
    if (subject) {
      const [result] = await Promise.allSettled([subject.disposeActiveTuiFixtures()]);
      if (result.status === "rejected" && !intentionalRetention) {
        throw result.reason;
      }
    }
  } finally {
    vi.restoreAllMocks();
    tempDirs.cleanup();
  }
});

describe("shared TUI PTY fixture ownership", () => {
  it.each(["config", "script"] as const)("rolls back a rejected %s write before launch", (stage) =>
    own(async () => {
      const failure = new Error(stage + " write rejected");
      let input = "";
      write.mockImplementation(async (file, data, options) => {
        const name = typeof file === "string" ? path.basename(file) : "";
        if (name === (stage === "config" ? "openclaw.json" : "run-tui-pty-fixture.mts")) {
          input = path.dirname(file as string);
          throw failure;
        }
        await fs.promises.writeFile(file, data, options);
      });

      await expect(subject!.startTuiFixture()).rejects.toBe(failure);
      expect(launch).not.toHaveBeenCalled();
      expect(fs.existsSync(input)).toBe(false);
      expect(() => owner.assertReleased()).not.toThrow();
      await subject!.disposeActiveTuiFixtures();
    }),
  );

  it("retains uncertain construction inputs and repeats the failed cleanup receipt", () =>
    own(async () => {
      const failure = new Error("opaque PTY construction rejected");
      let input = "";
      intentionalRetention = true;
      launch.mockImplementation(async (_exec, _args, options) => {
        input = path.dirname(options.env.OPENCLAW_CONFIG_PATH!);
        throw failure;
      });

      const startup = observe(subject!.startTuiFixture());
      const error = rejected(await startup.outcome) as AggregateError;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors[0]).toBe(failure);
      const cleanupError = error.errors[1] as AggregateError;
      expect(cleanupError).toBeInstanceOf(AggregateError);
      expect(cleanupError.errors).toContain(failure);
      expect(fs.existsSync(input)).toBe(true);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      await expect(subject!.disposeActiveTuiFixtures()).rejects.toBe(cleanupError);
      await expect(subject!.disposeActiveTuiFixtures()).rejects.toBe(cleanupError);
      expect(launch).toHaveBeenCalledOnce();
    }));

  it("joins held acquisition and cleanup without publishing a retired fixture", () =>
    own(async () => {
      const entered = createDeferred();
      const acquired = createDeferred<PtyRun>();
      const disposing = createDeferred();
      const allowDispose = hold();
      let input = "";
      const nativeDispose = vi.fn(async () => {
        disposing.resolve();
        await allowDispose.promise;
      });
      const run = makeRun(nativeDispose);
      releases.push(() => acquired.resolve(run));
      launch.mockImplementation(async (_exec, _args, options) => {
        input = path.dirname(options.env.OPENCLAW_CONFIG_PATH!);
        entered.resolve();
        return await acquired.promise;
      });
      const startup = observe(subject!.startTuiFixture());
      await reached(entered.promise, "PTY acquisition did not enter");
      const draining = subject!.disposeActiveTuiFixtures();
      const drain = observe(draining);
      expect(subject!.disposeActiveTuiFixtures()).toBe(draining);
      await expect(subject!.startTuiFixture()).rejects.toThrow("TUI PTY fixtures are closing");
      expect(launch).toHaveBeenCalledOnce();
      expect(startup.settled()).toBe(false);
      expect(drain.settled()).toBe(false);
      expect(fs.existsSync(input)).toBe(true);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");

      acquired.resolve(run);
      await reached(disposing.promise, "acquired PTY cleanup did not enter");
      await nextTurn();
      expect(startup.settled()).toBe(false);
      expect(drain.settled()).toBe(false);
      expect(fs.existsSync(input)).toBe(true);
      allowDispose.resolve();
      const error = rejected(await startup.outcome);
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("TUI PTY fixture closed during startup");
      await expect(drain.outcome).resolves.toEqual({ status: "fulfilled", value: undefined });
      expect(nativeDispose).toHaveBeenCalledOnce();
      expect(fs.existsSync(input)).toBe(false);
      expect(() => owner.assertReleased()).not.toThrow();

      launch.mockResolvedValueOnce(makeRun());
      const fresh = await subject!.startTuiFixture();
      await fresh.cleanup();
      expect(launch).toHaveBeenCalledTimes(2);
      expect(() => owner.assertReleased()).not.toThrow();
    }));

  it("starts every cleanup and retains only failed fixture inputs and claims", () =>
    own(async () => {
      const failure = new Error("native fixture cleanup rejected");
      const firstEntered = createDeferred();
      const siblingEntered = createDeferred();
      const allowFirst = hold();
      const allowSibling = hold();
      const failedDispose = vi.fn(async () => {
        firstEntered.resolve();
        await allowFirst.promise;
        throw failure;
      });
      const siblingDispose = vi.fn(async () => {
        siblingEntered.resolve();
        await allowSibling.promise;
      });
      intentionalRetention = true;
      launch.mockResolvedValueOnce(makeRun(failedDispose));
      const failed = await subject!.startTuiFixture();
      const siblingOwner = makeOwner();
      launch.mockResolvedValueOnce(makeRun(siblingDispose));
      const sibling = await subject!.startTuiFixture();
      const failedInput = path.dirname(failed.logPath);
      const siblingInput = path.dirname(sibling.logPath);
      const drain = observe(subject!.disposeActiveTuiFixtures());
      await reached(
        Promise.all([firstEntered.promise, siblingEntered.promise]),
        "cleanup skipped a sibling",
      );
      allowFirst.resolve();
      await nextTurn();
      expect(drain.settled()).toBe(false);
      expect(fs.existsSync(failedInput)).toBe(true);
      expect(fs.existsSync(siblingInput)).toBe(true);
      expect(() => siblingOwner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      allowSibling.resolve();

      const error = rejected(await drain.outcome) as AggregateError;
      expect(error).toBeInstanceOf(AggregateError);
      expect(error.errors).toContain(failure);
      expect(fs.existsSync(failedInput)).toBe(true);
      expect(fs.existsSync(siblingInput)).toBe(false);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      expect(() => siblingOwner.assertReleased()).not.toThrow();
      await expect(subject!.disposeActiveTuiFixtures()).rejects.toBe(error);
      expect(failedDispose).toHaveBeenCalledOnce();
      expect(siblingDispose).toHaveBeenCalledOnce();
    }));

  it("joins both installed release wrappers and native disposal before removing inputs", () =>
    own(async () => {
      const reconnectEntered = createDeferred();
      const startupEntered = createDeferred();
      const nativeEntered = createDeferred();
      const allowReconnect = hold();
      const allowStartup = hold();
      const allowNative = hold();
      const order: string[] = [];
      write.mockImplementation(async (file, data, options) => {
        const name = typeof file === "string" ? path.basename(file) : "";
        if (name === "reconnect.release") {
          order.push("reconnect");
          reconnectEntered.resolve();
          await allowReconnect.promise;
        } else if (name === "startup.release") {
          order.push("startup");
          startupEntered.resolve();
          await allowStartup.promise;
        }
        await fs.promises.writeFile(file, data, options);
      });
      const nativeDispose = vi.fn(async () => {
        order.push("native");
        nativeEntered.resolve();
        await allowNative.promise;
      });
      launch.mockResolvedValueOnce(makeRun(nativeDispose));
      const fixture = await subject!.startTuiFixture({
        holdStartupHistory: true,
        holdSessionDescription: true,
        holdReconnect: true,
      });
      const input = path.dirname(fixture.logPath);
      const cleaning = fixture.cleanup();
      const cleanup = observe(cleaning);
      expect(fixture.cleanup()).toBe(cleaning);
      await reached(reconnectEntered.promise, "reconnect release did not enter");
      expect(order).toEqual(["reconnect"]);
      expect(fs.existsSync(input)).toBe(true);
      allowReconnect.resolve();
      await reached(startupEntered.promise, "startup release did not enter");
      expect(order).toEqual(["reconnect", "startup"]);
      expect(fs.existsSync(input)).toBe(true);
      allowStartup.resolve();
      await reached(nativeEntered.promise, "native cleanup did not enter");
      await nextTurn();
      expect(order).toEqual(["reconnect", "startup", "native"]);
      expect(fs.existsSync(path.join(input, "reconnect.release"))).toBe(true);
      expect(fs.existsSync(path.join(input, "startup.release"))).toBe(true);
      expect(cleanup.settled()).toBe(false);
      expect(() => owner.assertReleased()).toThrow("Unreleased Vitest resource claim");
      allowNative.resolve();
      await expect(cleanup.outcome).resolves.toEqual({ status: "fulfilled", value: undefined });
      expect(fs.existsSync(input)).toBe(false);
      expect(() => owner.assertReleased()).not.toThrow();
      expect(nativeDispose).toHaveBeenCalledOnce();
    }));
});
