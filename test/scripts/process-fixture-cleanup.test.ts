import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import "../../src/test-utils/prepare-compiled-subprocesses.js";
import * as nodeProcess from "../../src/test-utils/node-process.js";
import { createDeferred } from "../helpers/promise.js";
import { runQaGatewayFixture } from "../helpers/qa-gateway-cleanup.js";

const testNodeExecPath = nodeProcess.resolveTestNodeExecPath();

const fixtures = [
  { owner: "setup", name: "forwards output and SIGTERM through the runner process group" },
  { owner: "timeout", name: "cleans timeout descendants before resolving the case" },
  { owner: "parent", name: "cleans active case descendants on parent signal" },
] as const;

afterEach(() => {
  for (const module of [
    "vitest",
    "node:fs",
    "node:child_process",
    "../../src/test-utils/node-process.js",
    "../../scripts/profile-extension-memory.mts",
    "../../scripts/lib/vitest-build-prerequisites.mts",
    "../helpers/fixture-receipts.js",
  ]) {
    vi.doUnmock(module);
  }
  vi.restoreAllMocks();
  vi.resetModules();
});

function errorTree(error: unknown): unknown[] {
  if (error instanceof AggregateError) {
    return error.errors.flatMap(errorTree);
  }
  return error instanceof Error && error.cause ? [error, ...errorTree(error.cause)] : [error];
}

type FixtureContext = {
  signal: AbortSignal;
  onTestFinished: (hook: () => unknown) => void;
};
type Hook = () => unknown;

function mockFs(overrides: object) {
  const fs = {
    mkdtempSync: () => "/fixture",
    mkdirSync() {},
    writeFileSync() {},
    ...overrides,
  };
  vi.doMock("node:fs", () => ({ ...fs, default: fs }));
  vi.doMock("../../scripts/lib/vitest-build-prerequisites.mts", () => ({}));
}

async function runFixture(owner: (typeof fixtures)[number]["owner"]) {
  vi.resetModules();
  const bodies = new Map<string, (context: FixtureContext) => Promise<void>>();
  const hooks: Record<"beforeAll" | "beforeEach" | "afterEach" | "afterAll", Hook[]> = {
    beforeAll: [],
    beforeEach: [],
    afterEach: [],
    afterAll: [],
  };
  const register = (name: string, body: (context: FixtureContext) => Promise<void>) =>
    bodies.set(name, body);
  const collectSuite = (_name: string, body: () => void) => body();
  vi.doMock("vitest", () => ({
    ...Object.fromEntries(
      Object.entries(hooks).map(([name, list]) => [name, (hook: Hook) => list.push(hook)]),
    ),
    describe: Object.assign(collectSuite, { runIf: () => collectSuite }),
    it: Object.assign(register, { each: () => () => {}, runIf: () => register, skip: register }),
    expect,
    vi,
  }));
  // Keep Bun's real Node prerequisite outside the synthetic filesystem and process faults.
  vi.doMock("../../src/test-utils/node-process.js", async (importOriginal) => ({
    ...(await importOriginal<typeof nodeProcess>()),
    resolveTestNodeExecPath: () => testNodeExecPath,
  }));
  await (owner === "setup"
    ? import("./vitest-e2e-global-setup.test.js")
    : import("./profile-extension-memory.test.js"));
  const fixture = fixtures.find((entry) => entry.owner === owner)!;
  const body = bodies.get(fixture.name);
  expect(body, fixture.name).toBeTypeOf("function");
  const finished: Hook[] = [];
  await runQaGatewayFixture(
    async () => {
      for (const hook of [...hooks.beforeAll, ...hooks.beforeEach]) {
        await hook();
      }
      await body!({
        signal: new AbortController().signal,
        onTestFinished: (hook) => finished.push(hook),
      });
    },
    ...hooks.afterEach.toReversed(),
    // The body registers these hooks, so enumerate them only after it settles.
    () => runQaGatewayFixture(async () => {}, ...finished.toReversed()),
    ...hooks.afterAll.toReversed(),
  );
}

describe.skipIf(process.platform === "win32")("process fixture cleanup faults", () => {
  it.each(fixtures.flatMap(({ owner }) => ["EPERM", "ESRCH"].map((code) => ({ owner, code }))))(
    "preserves failures and finishes safe $owner cleanup after $code",
    async ({ owner, code }) => {
      const childProcess =
        await vi.importActual<typeof import("node:child_process")>("node:child_process");
      const primary = new Error("fixture assertion failed");
      const denied = Object.assign(new Error("injected kill failure"), { code });
      const scratchError = new Error("scratch removal failed");
      const leader = 81001;
      const descendants = owner === "setup" ? [81002, 81003] : [81003];
      const alive = new Set([leader, ...descendants]);
      let parentSignaled = false;
      const events: string[] = [];
      const receiptReady = createDeferred();
      const child = Object.assign(new EventEmitter(), {
        pid: leader,
        exitCode: null as number | null,
        signalCode: null as NodeJS.Signals | null,
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
      });
      const close = () => {
        alive.delete(leader);
        child.signalCode = "SIGKILL";
        child.emit("exit", null, "SIGKILL");
        events.push("close");
        child.emit("close", null, "SIGKILL");
      };
      mockFs({
        existsSync: () => true,
        readFileSync: (file: string) =>
          String(file.endsWith("child.pid") ? descendants[0] : descendants.at(-1)),
        rmSync: () => {
          events.push("scratch");
          if (owner === "setup" && code === "EPERM") {
            throw scratchError;
          }
        },
      });
      vi.doMock("node:child_process", () => ({
        ...childProcess,
        spawn: () => {
          if (owner === "setup") {
            child.stdin.once("data", () => {
              child.stdout.write("setup-stdout\n");
              child.stderr.write("setup-stderr\n");
            });
          }
          setImmediate(() => {
            child.emit("spawn");
            if (owner === "timeout") {
              child.stdout.write(`descendant-ready ${descendants[0]}\n`);
            }
            receiptReady.resolve();
          });
          return child;
        },
      }));
      vi.doMock("../../scripts/profile-extension-memory.mts", () => ({
        runCase: async () => {
          throw primary;
        },
      }));
      vi.doMock("../helpers/fixture-receipts.js", async (importOriginal) => ({
        ...(await importOriginal<typeof import("../helpers/fixture-receipts.js")>()),
        openFixtureReceiptChannel: async () => ({
          endpoint: "/fixture/receipts",
          broadcastName: "fixture-receipts",
          waitFor: () => receiptReady.promise,
          close: async () => {},
        }),
      }));
      vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
        if (signal === 0) {
          if (pid < 0 ? alive.size > 0 : alive.has(pid)) {
            return true;
          }
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        events.push(`kill:${pid}`);
        if (signal === "SIGTERM" && !parentSignaled) {
          parentSignaled = true;
          throw primary;
        }
        const deniedTarget =
          owner === "setup" ? descendants[0] : owner === "timeout" ? -leader : leader;
        if (pid === deniedTarget) {
          if (code === "ESRCH") {
            alive.delete(Math.abs(pid));
            if (pid < 0) {
              alive.clear();
            }
            if (Math.abs(pid) === leader) {
              setImmediate(close);
            }
          }
          throw denied;
        }
        if (pid === -leader) {
          setImmediate(() => {
            alive.clear();
            close();
          });
        } else {
          alive.delete(pid);
          if (pid === leader) {
            setImmediate(close);
          }
        }
        return true;
      });

      const failure: unknown = await runFixture(owner).catch((error: unknown) => error);
      const errors = errorTree(failure);
      const expectedErrors = [primary];
      if (code === "EPERM") {
        expectedErrors.push(denied);
        if (owner === "setup") {
          expectedErrors.push(scratchError);
        }
        expect(events).toContain(`kill:${descendants.at(-1)}`);
      } else {
        expect(failure).not.toBeInstanceOf(AggregateError);
        if (owner !== "timeout") {
          expect(failure).toBe(primary);
        }
      }
      for (const expected of expectedErrors) {
        expect(errors).toContain(expected);
      }
      if (owner === "parent" && code === "EPERM") {
        expect(events).not.toContain("scratch");
        expect(errors).toContainEqual(
          expect.objectContaining({ message: expect.stringContaining("close") }),
        );
      } else {
        expect(events.indexOf("close")).toBeGreaterThan(-1);
        expect(events.indexOf("scratch")).toBeGreaterThan(events.indexOf("close"));
      }
    },
  );

  it("removes setup scratch after a fixture write fails before spawn", async () => {
    const primary = new Error("fixture write failed");
    const rmSync = vi.fn();
    mockFs({
      writeFileSync: () => {
        throw primary;
      },
      existsSync: () => false,
      rmSync,
    });
    await expect(runFixture("setup")).rejects.toBe(primary);
    expect(rmSync).toHaveBeenCalledWith("/fixture", { force: true, recursive: true });
  });
});
