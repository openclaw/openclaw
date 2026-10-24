// Exercise the harness through native Vitest forks, including its real hook ordering.
import type { ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, type TestContext } from "vitest";
import type { JsonTestResults } from "vitest/node";
import { hasErrnoCode } from "../../../src/infra/errno.ts";
import { runVitestShutdownCommand } from "../../../test/helpers/vitest-shutdown-command.ts";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(import.meta.dirname, "../../..");
const helperPath = path.join(repoRoot, "ui/src/e2e/control-ui-e2e-suite.test-support.ts");

type FixtureMode =
  | `page-concurrent${"" | "-timeout"}`
  | `diagnostic-${"page" | "tracked" | "scenario"}-timeout`
  | `tracked-close-${"success" | "failure"}`
  | "concurrent-close"
  | "held-route-drain"
  | "held-route-failure"
  | "close-failure"
  | "late-context"
  | "late-setup"
  | `scenario-${"timeout" | "noncooperative" | "late-close" | "close-failure" | "root-drain" | "root-leak"}`
  | `resources-${"success" | "root-drain" | "close-failure" | "late-setup" | "browser-failure"}`;

type FixtureJournal = {
  closeCalls: number;
  arrived: boolean;
  published: boolean;
  browserAcquired: boolean;
  browserClosed: boolean;
  serverAcquired: boolean;
  serverClosed: boolean;
  events: string[];
  nativeAbortObserved: boolean;
  firstCleanupEvent: string;
  pendingCloseCalls: number;
  fulfilledBeforeFetchRelease: string[];
  heldBodyErrorRetained: boolean;
  contextCleanupEvent: string;
  callbackOutcomes: { label: string; status: string; disposed: boolean }[];
};

function fixtureSource(mode: FixtureMode, root: string): string {
  return `
import { EventEmitter } from "node:events";
import fs from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterAll, expect, it, vi } from "vitest";
import { tryBeginGatewayRootWorkAdmission } from ${JSON.stringify(path.join(repoRoot, "src/process/gateway-work-admission.ts"))};
const state = vi.hoisted(() => {
  const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
  };
  const { promise: gate, resolve: release } = deferred();
  return { closeCalls: 0, arrived: false, published: false, gate, release, deferred,
    browserAcquired: false, browserClosed: false, serverAcquired: false, serverClosed: false,
    events: [], nativeAbortObserved: false,
    cleanupStarted: deferred(), laterFetch: deferred(), laterFetchStarted: deferred(),
    contextCleanupStarted: deferred(), contextFetch: deferred(), contextFetchStarted: deferred(),
    requestDisposed: deferred(), disposalFault: new Error("synthetic request context disposed"),
    firstCleanupEvent: "", pendingCloseCalls: -1, fulfilledBeforeFetchRelease: [],
    heldBodyErrorRetained: false, contextCleanupEvent: "", callbackOutcomes: [],
    pendingPageReject: undefined,
    heldRouteFault: new Error("synthetic held module route failure"),
    closeFault: new Error("synthetic context close failure") };
});
vi.mock("playwright", () => ({ chromium: { launch: async () => {
  if (${JSON.stringify(mode)} === "resources-browser-failure") throw new Error("synthetic browser startup failure");
  state.browserAcquired = true;
  return {
    newContext: async () => {
      if (${JSON.stringify(mode)} === "late-context") await new Promise(resolve => setTimeout(resolve, 40));
      state.arrived = true;
      const rejectClosedPage = async () => { throw new Error("synthetic page closed"); };
      const closedPage = Object.assign(new EventEmitter(), {
        evaluate: rejectClosedPage,
        screenshot: rejectClosedPage,
        isClosed: () => true,
        url: () => "about:blank",
      });
      const makeContext = (page, overrides) => {
        const context = Object.assign(new EventEmitter(), {
          setDefaultTimeout() {},
          addInitScript: async () => {},
          pages: () => [page],
          newPage: async () => { context.emit("page", page); return page; },
          ...overrides,
        });
        return context;
      };
      if (${JSON.stringify(mode)}.startsWith("diagnostic-") || ${JSON.stringify(mode)}.startsWith("page-concurrent")) {
        let pageClosed = false;
        let context;
        const page = Object.assign(new EventEmitter(), {
          ...closedPage,
          isClosed: () => pageClosed,
          context: () => context,
          frames: () => [],
          evaluate: async () => {
            state.events.push(pageClosed ? "capture closed page" : "capture live page");
            record();
            if (pageClosed) throw new Error("synthetic page closed");
            return { failureSummary: { available: true } };
          },
        });
        context = makeContext(page, {
          pages: () => pageClosed ? [] : [page],
          browser: () => ({ isConnected: () => true }),
          unrouteAll: async () => { state.events.push("drain"); record(); },
          close: async () => {
            pageClosed = true;
            state.closeCalls++;
            state.events.push("close");
            page.emit("close");
            state.pendingPageReject?.(new Error("synthetic page closed"));
            record();
          },
        });
        return context;
      }
      if (${JSON.stringify(mode)}.startsWith("held-route-")) {
        const handlers = [];
        const pending = new Set();
        const contextHandlers = [];
        const contextPending = new Set();
        let pageClosed = false;
        let context;
        const page = Object.assign(new EventEmitter(), {
          ...closedPage,
          isClosed: () => pageClosed,
          context: () => context,
          route: async (pattern, handler) => { handlers.push({ pattern, handler }); },
          unrouteAll: async (options) => {
            expect(options).toEqual({ behavior: "wait" });
            handlers.length = 0;
            state.events.push("drain");
            state.cleanupStarted.resolve("drain");
            await Promise.all([...pending]);
          },
          dispatchModule: (name, label, scope = "page") => {
            const url = "https://fixture.invalid/" + name + ".js";
            const registrations = scope === "context" ? contextHandlers : handlers;
            const invocations = scope === "context" ? contextPending : pending;
            const registration = registrations.find(({ pattern }) => pattern.test(url));
            if (!registration) throw new Error("missing held-module route: " + name);
            const handled = state.deferred();
            const route = {
              request: () => ({ url: () => url }),
              fallback: async () => {
                state.events.push("fell through " + label);
                handled.resolve();
              },
              abort: async () => {
                state.events.push("aborted " + label);
                handled.resolve();
                record();
              },
              fetch: async () => {
                if (pageClosed) throw state.disposalFault;
                if (label === "fault") throw state.heldRouteFault;
                if (label === "later" || scope === "context") {
                  const started = scope === "context" ? state.contextFetchStarted : state.laterFetchStarted;
                  const gate = scope === "context" ? state.contextFetch : state.laterFetch;
                  started.resolve();
                  await Promise.race([
                    gate.promise,
                    state.requestDisposed.promise.then(() => { throw state.disposalFault; }),
                  ]);
                }
                if (pageClosed) throw state.disposalFault;
                state.events.push("fetched " + label);
                return { status: () => 200 };
              },
              fulfill: async () => {
                if (pageClosed) throw state.disposalFault;
                state.events.push("fulfilled " + label);
                handled.resolve();
              },
            };
            // Playwright joins both route handling and callback completion.
            const settled = Promise.all([handled.promise, registration.handler(route)]).then(
              () => ({ label, status: "fulfilled" }),
              error => ({ label, status: "rejected", error }),
            );
            invocations.add(settled);
            void settled.then(() => invocations.delete(settled));
            return settled;
          },
        });
        context = makeContext(page, {
          route: async (pattern, handler) => { contextHandlers.push({ pattern, handler }); },
          unrouteAll: async (options) => {
            expect(options).toEqual({ behavior: "wait" });
            contextHandlers.length = 0;
            state.contextCleanupStarted.resolve("drain");
            await Promise.all([...contextPending]);
          },
          close: async () => {
            pageClosed = true;
            state.requestDisposed.resolve();
            state.closeCalls++;
            state.events.push("close");
            state.cleanupStarted.resolve("close");
            state.contextCleanupStarted.resolve("close");
            record();
          },
        });
        return context;
      }
      return makeContext(closedPage, {
        pages: () => [],
        unrouteAll: async () => {},
        close: () => {
          state.closeCalls++;
          record();
          if (["close-failure", "tracked-close-failure"].includes(${JSON.stringify(mode)})) return Promise.reject(state.closeFault);
          return ${JSON.stringify(mode)} === "concurrent-close" && state.closeCalls === 1
            ? state.gate : Promise.resolve();
        }
      });
    },
    close: async () => { state.browserClosed = true; record(); },
  };
} } }));
import { createControlUiE2eSuite, holdModuleResponse } from ${JSON.stringify(helperPath)};
const journalKeys = ["closeCalls", "arrived", "published", "browserAcquired", "browserClosed",
  "serverAcquired", "serverClosed", "events", "nativeAbortObserved", "firstCleanupEvent",
  "pendingCloseCalls", "fulfilledBeforeFetchRelease", "heldBodyErrorRetained",
  "contextCleanupEvent", "callbackOutcomes"];
const record = () => fs.writeFileSync(${JSON.stringify(path.join(root, "journal.json"))},
  JSON.stringify(Object.fromEntries(journalKeys.map(key => [key, state[key]]))));
const event = name => { state.events.push(name); record(); };
const successor = () => fs.writeFileSync(${JSON.stringify(path.join(root, "successor.txt"))}, "started");
fs.writeFileSync(${JSON.stringify(path.join(root, "worker.pid"))}, String(process.pid));
record();
async function waitForAbort(signal) {
  await new Promise(resolve => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", resolve, { once: true });
  });
}
// These synthetic gateways open no databases. Keep their state fixture limited to
// the directory and selector whose lifetime belongs to the suite release callback.
function createFixtureState() {
  const root = ${JSON.stringify(path.join(root, "retained-state"))};
  const previousStateDir = process.env.OPENCLAW_STATE_DIR;
  fs.mkdirSync(root);
  process.env.OPENCLAW_STATE_DIR = root;
  return {
    root,
    stateDir: root,
    cleanup: async () => {
      if (previousStateDir === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previousStateDir;
      await fs.promises.rm(root, { recursive: true, force: true });
    },
  };
}
let sharedFixture;
let gatewayAdmission;
function scenario(acquired, run, close, optionalRelease = false) {
  let fixture;
  return {
    retainedState: () => fixture?.root,
    run: async signal => {
      fixture = createFixtureState();
      fs.writeFileSync(${JSON.stringify(path.join(root, "retained-root.txt"))}, fixture.root);
      await run(signal, fixture, () => event(acquired));
    },
    close,
    release: async () => {
      if (optionalRelease) await fixture?.cleanup();
      else await fixture.cleanup();
      event("released");
    },
  };
}
const suite = createControlUiE2eSuite({ name: "owned context fixture",
  trackBrowserContexts: ${mode.startsWith("tracked-") || mode === "diagnostic-tracked-timeout"},
  ...(${JSON.stringify(mode)}.startsWith("resources-") ? {
    resources: {
      retainedState: () => sharedFixture?.root,
      run: async signal => {
        sharedFixture = createFixtureState();
        if (${JSON.stringify(mode)} === "resources-root-drain") {
          gatewayAdmission = tryBeginGatewayRootWorkAdmission("synthetic shared Gateway request");
          expect(gatewayAdmission).not.toBeNull();
        }
        fs.writeFileSync(${JSON.stringify(path.join(root, "retained-root.txt"))}, sharedFixture.root);
        event("resource acquired");
        if (${JSON.stringify(mode)} === "resources-late-setup") {
          await waitForAbort(signal);
          signal.throwIfAborted();
        }
      },
      close: async () => {
        gatewayAdmission?.release();
        event("resource closed");
        if (${JSON.stringify(mode)} === "resources-close-failure") throw new Error("synthetic shared resource close failure");
      },
      release: async () => { await sharedFixture.cleanup(); event("released"); },
    },
  } : {}),
  startServerBeforeBrowser: ${mode === "late-setup"},
  startServer: async () => {
    if (${JSON.stringify(mode)} === "late-setup") await new Promise(resolve => setTimeout(resolve, 75));
    state.serverAcquired = true;
    return { baseUrl: "http://fixture.invalid/", close: async () => { state.serverClosed = true; record(); } };
  },
});
suite.define(() => {
  if (${JSON.stringify(mode)} === "page-concurrent") {
    it("keeps concurrent page callbacks independently alive", async () => {
      const shortGate = state.deferred();
      const longGate = state.deferred();
      const longReady = state.deferred();
      const short = suite.withPage({}, async () => { await shortGate.promise; });
      const long = suite.withPage({}, async ({ page }) => {
        longReady.resolve(page);
        await longGate.promise;
        expect(page.isClosed()).toBe(false);
      });
      try {
        const page = await longReady.promise;
        shortGate.resolve();
        await short;
        expect(page.isClosed()).toBe(false);
      } finally {
        shortGate.resolve();
        longGate.resolve();
        await Promise.all([short, long]);
      }
    });
  } else if (${JSON.stringify(mode)} === "page-concurrent-timeout") {
    it("joins every concurrent callback after native cancellation", async () => {
      await Promise.all([
        suite.withPage({}, async ({ page }) => {
          await new Promise(resolve => page.once("close", resolve));
        }),
        suite.withPage({}, async () => { await new Promise(() => {}); }),
      ]);
    }, 50);
    it("never starts while a concurrent callback remains unjoined", () => {
      successor();
    });
  } else if (${JSON.stringify(mode)}.startsWith("diagnostic-")) {
    it("retains the native page timeout", async (context) => {
      const awaitTimeout = async (page) => {
        expect(page.listenerCount("websocket"), "one RPC observer owns each page").toBe(1);
        const socket = new EventEmitter();
        page.emit("websocket", socket);
        const frame = (direction, value) => socket.emit(direction, { payload: JSON.stringify(value) });
        for (const method of ["agents.files.get",
          "chat.history", "chat.startup", "sessions.list", "sessions.subscribe",
          "sessions.unsubscribe", "sessions.messages.subscribe", "sessions.messages.unsubscribe",
          "connect", "private-unknown-method"]) {
          for (const ok of [true, false]) {
            frame("framesent", { type: "req", id: "private-request-id", method,
              params: { token: "private-token", sessionKey: "private-session", text: "private-content" } });
            frame("framereceived", { type: "res", id: "private-request-id", ok,
              payload: { text: "private-content" }, error: { message: "private-error" } });
          }
        }
        await new Promise((resolve, reject) => { state.pendingPageReject = reject; });
      };
      const run = async () => {
        if (${JSON.stringify(mode)} === "diagnostic-page-timeout") {
          await suite.withPage({}, ({ page }) => awaitTimeout(page));
        } else {
          const browserContext = await suite.newBrowserContext({});
          await awaitTimeout(await browserContext.newPage());
        }
      };
      if (${JSON.stringify(mode)} === "diagnostic-scenario-timeout") {
        await suite.runScenario(context, { run });
      } else {
        await run();
      }
    }, 50);
    it("starts the successor after timeout cleanup", () => {
      event("successor");
      successor();
    });
  } else if (${JSON.stringify(mode)}.startsWith("scenario-root-")) {
    it("closes its Gateway before requiring requests to drain", async (context) => {
      await suite.runScenario(context, scenario("acquired", async (_signal, _fixture, acquired) => {
          gatewayAdmission = tryBeginGatewayRootWorkAdmission("synthetic scenario Gateway request");
          expect(gatewayAdmission).not.toBeNull();
          acquired();
          await suite.withPage({}, async () => {});
        }, async () => {
          event("gateway closed");
          if (${JSON.stringify(mode)} === "scenario-root-drain") gatewayAdmission.release();
        }));
    });
  } else if (${JSON.stringify(mode)}.startsWith("resources-")) {
    it.for(["first", "second"])("uses shared resources: %s", async (name, context) => {
      await suite.runScenario(context, { run: async () => {
        expect(process.env.OPENCLAW_STATE_DIR).toBe(sharedFixture.stateDir);
        event(name);
        if (${JSON.stringify(mode)} === "resources-root-drain") {
          await suite.withPage({}, async () => {});
        }
      } });
    });
  } else if (${JSON.stringify(mode)}.startsWith("tracked-")) {
    it("first ordinary case acquires a context", async () => {
      await suite.newBrowserContext({});
    });
    it("next ordinary case starts only after context cleanup", async () => {
      successor();
      await suite.newBrowserContext({});
    });
  } else if (${JSON.stringify(mode)} === "held-route-drain") {
    it("records held-module cleanup after an early body failure", async () => {
      const bodyFault = new Error("synthetic held-module body failure");
      const callbacks = [];
      let firstHold;
      let otherHold;
      let heldPage;
      const outcome = suite.withPage({}, async ({ context, page }) => {
        heldPage = page;
        firstHold = await holdModuleResponse(page, /module-a/u);
        otherHold = await holdModuleResponse(page, /module-b/u);
        callbacks.push(page.dispatchModule("module-a", "first"));
        await firstHold.request;
        callbacks.push(page.dispatchModule("module-b", "other"));
        await otherHold.request;
        // The first request promise has settled, but a later matching fetch is still owned.
        callbacks.push(page.dispatchModule("module-a", "later"));
        await state.laterFetchStarted.promise;
        await context.route(/context-font/u, async (route) => {
          const response = await route.fetch();
          await route.fulfill({ response });
        });
        callbacks.push(page.dispatchModule("context-font", "context", "context"));
        await state.contextFetchStarted.promise;
        throw bodyFault;
      }).then(() => undefined, error => error);
      let failure;
      let callbackOutcomes;
      try {
        await state.contextFetchStarted.promise;
        await Promise.all(callbacks.slice(0, 2));
        await nextTurn();
        state.pendingCloseCalls = state.closeCalls;
        state.fulfilledBeforeFetchRelease = state.events.filter(event => event.startsWith("fulfilled "));
        expect(state.events).not.toContain("drain");
        callbacks.push(heldPage.dispatchModule("module-a", "late"));
        await callbacks.at(-1);
        record();
        state.laterFetch.resolve();
        state.firstCleanupEvent = await state.cleanupStarted.promise;
        state.contextCleanupEvent = await state.contextCleanupStarted.promise;
      } finally {
        firstHold?.release();
        otherHold?.release();
        state.laterFetch.resolve();
        state.contextFetch.resolve();
        callbackOutcomes = await Promise.all(callbacks);
        failure = await outcome;
      }
      state.callbackOutcomes = callbackOutcomes.map(({ label, status, error }) => ({
        label, status, disposed: status === "rejected" && error === state.disposalFault,
      }));
      state.heldBodyErrorRetained = failure === bodyFault;
      record();
      for (const result of callbackOutcomes) {
        if (result.status === "rejected") expect(result.error).toBe(state.disposalFault);
      }
      expect(failure).toBe(bodyFault);
    });
    it("settles unrequested module observation during context cleanup", async () => {
      const acquired = state.deferred();
      const outcome = suite.withPage({}, async ({ context, page }) => {
        const released = await holdModuleResponse(page, /module-unblocked/u);
        released.release();
        const callback = page.dispatchModule("module-unblocked", "unblocked");
        expect(await released.request).toBe("https://fixture.invalid/module-unblocked.js");
        expect(await callback).toMatchObject({ status: "fulfilled" });

        const held = await holdModuleResponse(page, /module-never-requested/u);
        await holdModuleResponse(page, /module-unobserved/u);
        acquired.resolve(context);
        try {
          await held.request;
        } finally {
          event("held request settled");
        }
      }).then(() => undefined, error => error);
      await suite.closeBrowserContext(await acquired.promise);
      expect(await outcome).toMatchObject({
        message: "Browser context cleanup canceled the held module request",
      });
      event("held callback joined");
    });
  } else if (${JSON.stringify(mode)} === "held-route-failure") {
    it("reports a settled held route failure during context cleanup", async () => {
      await suite.withPage({}, async ({ page }) => {
        await holdModuleResponse(page, /module-fault/u);
        const outcome = await page.dispatchModule("module-fault", "fault");
        expect(outcome.label).toBe("fault");
      });
    });
  } else if (${JSON.stringify(mode)} === "concurrent-close") {
    it("joins the first context close", async () => {
      const context = await suite.newBrowserContext({});
      const first = suite.closeBrowserContext(context);
      let secondSettled = false;
      const second = suite.closeBrowserContext(context).then(() => { secondSettled = true; });
      try {
        await nextTurn();
        expect.soft(secondSettled).toBe(false);
        expect.soft(state.closeCalls).toBe(1);
      } finally {
        state.release();
        await Promise.all([first, second]);
      }
    });
  } else if (${JSON.stringify(mode)} === "close-failure") {
    it("preserves the body and finalization failures", async () => {
      const bodyFault = new Error("synthetic page body failure");
      const failure = await suite.withPage({}, async () => { throw bodyFault; }).catch(error => error);
      const leaves = error => error instanceof AggregateError ? error.errors.flatMap(leaves) : [error];
      const errors = [...new Set(leaves(failure))];
      expect(errors).toHaveLength(2);
      expect(errors).toContain(bodyFault);
      expect(errors).toContain(state.closeFault);
      state.heldBodyErrorRetained = true;
      record();
    });
    it("never starts after page cleanup fails", () => {
      successor();
    });
  } else if (${JSON.stringify(mode)} === "late-context") {
    it.fails("times out during context acquisition", async () => {
      await suite.newBrowserContext({});
      state.published = true;
    }, 5);
  } else if (${JSON.stringify(mode)} === "late-setup") {
    it("never starts after setup timed out", () => { state.published = true; record(); });
  } else {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    it.fails("first usage-style attempt times out or fails cleanup", async (context) => {
      await suite.runScenario(context, scenario("acquired", async (signal, _fixture, acquired) => {
          acquired();
          if (${JSON.stringify(mode)} === "scenario-noncooperative") await new Promise(() => {});
          if (["scenario-close-failure", "scenario-late-close"].includes(${JSON.stringify(mode)})) return;
          await waitForAbort(signal);
          state.nativeAbortObserved = signal.aborted; record();
          signal.throwIfAborted();
        }, async () => {
          event("gateway closed");
          if (${JSON.stringify(mode)} === "scenario-late-close") await state.gate;
          if (${JSON.stringify(mode)} === "scenario-close-failure") throw new Error("synthetic gateway close failure");
        }, true));
    }, 50);
    it("next usage-style attempt starts only after the original cleanup", () => {
      successor();
      expect(state.events).toEqual(["acquired", "gateway closed", "released"]);
      expect(state.nativeAbortObserved).toBe(true);
      expect(process.env.OPENCLAW_STATE_DIR).toBe(previousStateDir);
    });
  }
});
if (${JSON.stringify(mode)} === "scenario-late-close") {
  afterAll(async () => {
    state.release();
    await nextTurn();
    event("late close settled");
  });
}
`;
}

let fixtureRoot: string;
let hasUnjoinedFixture = false;
const readJson = async <T>(file: string): Promise<T> => JSON.parse(await fs.readFile(file, "utf8"));

beforeAll(async () => {
  // openclaw-temp-dir: allow retain native-fork state if process-tree shutdown fails.
  fixtureRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ui-lifetime-forks-")));
  await fs.symlink(
    path.join(repoRoot, "node_modules"),
    path.join(fixtureRoot, "node_modules"),
    "junction",
  );
  await fs.writeFile(
    path.join(fixtureRoot, "vitest.config.ts"),
    `
import { defineConfig } from "vitest/config";
import { createVitestResolveConfig } from ${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.resolve.ts"))};
if (process.versions.bun) {
  await import(${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.sqlite-preload.mts"))});
}
const hookTimeout = Number(process.env.UI_LIFETIME_HOOK_TIMEOUT_MS);
export default defineConfig({
  cacheDir: ${JSON.stringify(path.join(fixtureRoot, ".vite"))},
  resolve: createVitestResolveConfig(${JSON.stringify(repoRoot)}),
  test: { pool: "forks", isolate: true, maxWorkers: 1, fileParallelism: false,
    fsModuleCache: true,
    fsModuleCachePath: ${JSON.stringify(path.join(fixtureRoot, "transforms"))},
    testTimeout: 1000, hookTimeout,
    provide: {
      controlUiE2eChromium: { available: true, executablePath: "/synthetic/chromium" },
      controlUiE2eCleanup: { timeoutMs: hookTimeout, pool: "forks", isolate: true },
    },
  },
});
`,
  );
});

afterAll(async () => {
  if (!hasUnjoinedFixture) {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  }
});

async function runFixture(mode: FixtureMode, signal: AbortSignal) {
  if (hasUnjoinedFixture) {
    throw new Error("Cannot reuse transforms while a native UI fixture remains unjoined");
  }
  // The serial native children share transforms, never a worker or mutable case state.
  const root = path.join(fixtureRoot, mode);
  const hookTimeout = mode === "late-setup" || mode === "resources-late-setup" ? 50 : 500;
  let completed = false;
  try {
    const vitestPackageDir = path.dirname(require.resolve("vitest/package.json"));
    await fs.mkdir(path.join(root, "home"), { recursive: true });
    await fs.mkdir(path.join(root, "tmp"));
    await fs.writeFile(path.join(root, "fixture.test.ts"), fixtureSource(mode, root));
    const report = path.join(root, "report.json");
    let child!: ChildProcess;
    const output = await runVitestShutdownCommand({
      args: [
        path.join(vitestPackageDir, "vitest.mjs"),
        "run",
        path.join(root, "fixture.test.ts"),
        "--root",
        fixtureRoot,
        "--config",
        path.join(fixtureRoot, "vitest.config.ts"),
        "--configLoader",
        "runner",
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile=${report}`,
      ],
      cwd: repoRoot,
      signal,
      timeoutMs: 90_000,
      maxBytes: 4 * 1024 * 1024,
      env: {
        PATH: process.env.PATH,
        UI_LIFETIME_HOOK_TIMEOUT_MS: String(hookTimeout),
        HOME: path.join(root, "home"),
        USERPROFILE: path.join(root, "home"),
        OPENCLAW_HOME: path.join(root, "home"),
        OPENCLAW_STATE_DIR: path.join(root, "home/.openclaw"),
        OPENCLAW_CONFIG_PATH: path.join(root, "home/.openclaw/openclaw.json"),
        OPENCLAW_UI_E2E_DIAGNOSTIC_DIR: path.join(root, "diagnostics"),
        TMPDIR: path.join(root, "tmp"),
        TMP: path.join(root, "tmp"),
        TEMP: path.join(root, "tmp"),
        CI: "1",
        NO_COLOR: "1",
      },
      onReady(owned) {
        child = owned;
      },
    });
    expect(child.signalCode, `${output.stdout}\n${output.stderr}`).toBeNull();
    expect(child.killed).toBe(false);
    const pid = Number(await fs.readFile(path.join(root, "worker.pid"), "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    let workerStopped = false;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (!hasErrnoCode(error, "ESRCH")) {
        throw error;
      }
      workerStopped = true;
    }
    expect(workerStopped, "native fixture worker must be joined before removing its files").toBe(
      true,
    );
    completed = true;
    const nativeReport = await readJson<JsonTestResults>(report);
    let retainedExists = false;
    if (mode === "resources-browser-failure") {
      await expect(fs.stat(path.join(root, "retained-root.txt"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } else if (mode.startsWith("scenario-") || mode.startsWith("resources-")) {
      const retainedRoot = await fs.readFile(path.join(root, "retained-root.txt"), "utf8");
      expect(path.relative(root, retainedRoot).startsWith("..")).toBe(false);
      retainedExists = await fs.stat(retainedRoot).then(
        () => true,
        () => false,
      );
    }
    type Capture = {
      public: {
        hostBeforeRead: { pageClosed: boolean };
        rendererRead: string;
        gatewayRpc: Array<{ method: string; outcome: string }>;
      };
      private: { failure: { message: string } };
    };
    const captures: Capture[] = [];
    if (mode.startsWith("diagnostic-")) {
      for (const entry of await fs.readdir(path.join(root, "diagnostics"))) {
        captures.push({
          public: await readJson<Capture["public"]>(
            path.join(root, "diagnostics", entry, "failure.public.json"),
          ),
          private: await readJson<Capture["private"]>(
            path.join(root, "diagnostics", entry, "failure.private.json"),
          ),
        });
      }
    }
    return {
      captures,
      code: child.exitCode,
      output: `${output.stdout}\n${output.stderr}`,
      report: nativeReport,
      journal: await readJson<FixtureJournal>(path.join(root, "journal.json")),
      retainedExists,
      successorStarted: await fs.stat(path.join(root, "successor.txt")).then(
        () => true,
        () => false,
      ),
    };
  } finally {
    if (completed) {
      await fs.rm(root, { recursive: true, force: true });
    } else {
      hasUnjoinedFixture = true;
      console.warn(`Retained unjoined native UI fixture: ${root}`);
    }
  }
}

function runJoinedFixture(
  mode: FixtureMode,
  context: TestContext,
  check: (result: Awaited<ReturnType<typeof runFixture>>) => void,
) {
  // Register before the body starts: native timeout does not join its callback.
  const run = Promise.resolve().then(() => {
    context.signal.throwIfAborted();
    return runFixture(mode, context.signal).then(check);
  });
  context.onTestFinished(() => run);
  return run;
}

type FixtureResult = Awaited<ReturnType<typeof runFixture>>;

function expectTestCounts(result: FixtureResult, passed: number, failed: number) {
  expect(result.report, result.output).toMatchObject({
    numPassedTests: passed,
    numFailedTests: failed,
  });
}

function expectClosed(result: FixtureResult, closeCalls: number, closed = true) {
  expect(result.journal).toMatchObject({
    closeCalls,
    browserClosed: closed,
    serverClosed: closed,
  });
}

it.for(["page-concurrent", "page-concurrent-timeout"] as const)(
  "owns every concurrent page callback: %s",
  (mode, context) =>
    runJoinedFixture(mode, context, (result) => {
      const timedOut = mode === "page-concurrent-timeout";
      expect(result.code, result.output).toBe(timedOut ? 1 : 0);
      expect(result.journal.closeCalls).toBe(2);
      if (timedOut) {
        expect(result.output).toContain("Test timed out in 50ms");
        expect(result.output).toContain("retiring owned fork");
        expect(result.successorStarted).toBe(false);
      } else {
        expectTestCounts(result, 1, 0);
      }
    }),
);

it.for([
  "diagnostic-page-timeout",
  "diagnostic-tracked-timeout",
  "diagnostic-scenario-timeout",
] as const)("captures a native timeout before its context closes: %s", (mode, context) =>
  runJoinedFixture(mode, context, (result) => {
    expect(result.code, result.output).toBe(1);
    expectTestCounts(result, 1, 1);
    expect(result.output).toContain("Test timed out in 50ms");
    expect(result.successorStarted).toBe(true);
    expect(result.journal.events).toEqual(["capture live page", "drain", "close", "successor"]);
    expect(result.captures).toHaveLength(1);
    expect(result.captures[0]?.public).toMatchObject({
      hostBeforeRead: { pageClosed: false },
      rendererRead: "completed",
    });
    expect(result.captures[0]?.public.gatewayRpc).toEqual(
      [
        "agents.files.get",
        "chat.history",
        "chat.startup",
        "sessions.list",
        "sessions.subscribe",
        "sessions.unsubscribe",
        "sessions.messages.subscribe",
        "sessions.messages.unsubscribe",
      ].flatMap((method) => [
        { method, outcome: "sent" },
        { method, outcome: "ok" },
        { method, outcome: "sent" },
        { method, outcome: "error" },
      ]),
    );
    expect(JSON.stringify(result.captures[0]?.public)).not.toContain("private-");
    expect(result.captures[0]?.private.failure.message).toContain("Test timed out in 50ms");
    expectClosed(result, 1);
  }),
);

it("drains held modules and cancels unrequested observations during cleanup", (context) =>
  runJoinedFixture("held-route-drain", context, (result) => {
    expect(result.code, result.output).toBe(0);
    expectTestCounts(result, 2, 0);
    expect(result.journal.callbackOutcomes).toEqual(
      ["first", "other", "later", "context", "late"].map((label) => ({
        label,
        status: "fulfilled",
        disposed: false,
      })),
    );
    expect(result.journal.events).toContain("fulfilled later");
    expect(result.journal.events).toContain("fell through late");
    expect(result.journal.events).not.toContain("fetched late");
    for (const event of ["drain", "close"]) {
      expect(result.journal.events.indexOf("fulfilled later")).toBeLessThan(
        result.journal.events.indexOf(event),
      );
    }
    expect(result.journal.events).toContain("held request settled");
    expect(result.journal.events.at(-1)).toBe("held callback joined");
    expect(result.journal).toMatchObject({
      firstCleanupEvent: "drain",
      contextCleanupEvent: "drain",
      pendingCloseCalls: 0,
      fulfilledBeforeFetchRelease: ["fulfilled first", "fulfilled other"],
      heldBodyErrorRetained: true,
    });
    expectClosed(result, 2);
  }));

it("reports settled held route failures through context cleanup", (context) =>
  runJoinedFixture("held-route-failure", context, (result) => {
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("synthetic held module route failure");
    expect(result.output).not.toContain("Unhandled Rejection");
    expect(result.journal.events).toContain("aborted fault");
  }));

it.for([
  ["concurrent-close", true, 1],
  ["close-failure", false, 1],
  ["late-context", true, 1],
  ["tracked-close-success", true, 2],
  ["tracked-close-failure", false, 1],
] as const)(
  "preserves native browser resource ownership: %s",
  ([mode, success, closeCalls], context) =>
    runJoinedFixture(mode, context, (result) => {
      const tracked = mode.startsWith("tracked-");
      expect(result.code, result.output).toBe(success ? 0 : 1);
      expectClosed(result, closeCalls, success);
      if (!tracked) {
        expectTestCounts(result, success ? 1 : 0, success ? 0 : 2);
        expect(result.journal).toMatchObject({ arrived: true, published: false });
      }
      if (tracked || !success) {
        expect(result.successorStarted, result.output).toBe(success);
      }
      if (!success) {
        expect(result.output).toContain("synthetic context close failure");
        expect(result.output).toContain("retiring owned fork");
      }
      if (mode === "close-failure") {
        expect(result.journal.heldBodyErrorRetained).toBe(true);
      }
    }),
);

it("joins late suite setup before closing its acquired server", (context) =>
  runJoinedFixture("late-setup", context, (result) => {
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain("Hook timed out");
    expect(result.journal).toMatchObject({
      serverAcquired: true,
      serverClosed: true,
      browserAcquired: false,
      published: false,
    });
  }));

it.for(["scenario-root-drain", "resources-root-drain", "scenario-root-leak"] as const)(
  "drains Gateway requests at the owner close boundary: %s",
  (mode, context) =>
    runJoinedFixture(mode, context, (result) => {
      const leaked = mode === "scenario-root-leak";
      expect(result.code, result.output).toBe(leaked ? 1 : 0);
      expect(result.retainedExists).toBe(leaked);
      expect(result.journal.events).toContain(
        mode.startsWith("resources-") ? "resource closed" : "gateway closed",
      );
      expect(result.journal.events.includes("released")).toBe(!leaked);
    }),
);

it.for([
  ["scenario-timeout", undefined],
  ["scenario-noncooperative", "scenario cleanup did not settle within 500ms"],
  ["scenario-late-close", "scenario cleanup did not settle within 500ms"],
  ["scenario-close-failure", "synthetic gateway close failure"],
] as const)(
  "joins scenario cleanup or retires the unsafe fork and retains its state: %s",
  ([mode, failure], context) =>
    runJoinedFixture(mode, context, (result) => {
      expect(result.code, result.output).toBe(failure ? 1 : 0);
      expect(result.retainedExists).toBe(Boolean(failure));
      expect(result.successorStarted).toBe(!failure);
      if (failure) {
        expect(result.report.numFailedTests, result.output).toBeGreaterThan(0);
        expect(result.output).toContain("retiring owned fork");
        expect(result.output).toContain(failure);
        expect(result.journal.events).not.toContain("released");
      } else {
        expectTestCounts(result, 2, 0);
        expect(result.journal.events).toEqual(["acquired", "gateway closed", "released"]);
      }
      if (mode === "scenario-late-close") {
        expect(result.journal.events).toContain("late close settled");
      }
    }),
);

it.for([
  ["resources-success", false, undefined],
  ["resources-close-failure", true, "synthetic shared resource close failure"],
  ["resources-late-setup", true, "Hook timed out"],
  ["resources-browser-failure", false, "synthetic browser startup failure"],
] as const)(
  "owns shared state through native suite cleanup: %s",
  ([mode, retained, failure], context) =>
    runJoinedFixture(mode, context, (result) => {
      expect(result.code, result.output).toBe(failure ? 1 : 0);
      expect(result.retainedExists).toBe(retained);
      if (failure) {
        expect(result.output).toContain(failure);
      }
      if (mode === "resources-browser-failure") {
        expect(result.journal.events).toEqual([]);
        return;
      }
      expect(result.report.success, result.output).toBe(!failure);
      if (mode === "resources-late-setup") {
        expect(result.journal.events).toEqual(["resource acquired", "resource closed"]);
      } else {
        expect(result.report.numPassedTests, result.output).toBe(2);
        expect(result.journal.events).toEqual([
          "resource acquired",
          "first",
          "second",
          "resource closed",
          ...(failure ? [] : ["released"]),
        ]);
      }
    }),
);
