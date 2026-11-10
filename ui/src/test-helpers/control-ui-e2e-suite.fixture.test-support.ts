import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const helperPath = path.join(repoRoot, "ui/src/e2e/control-ui-e2e-suite.test-support.ts");

export type FixtureMode =
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

export function fixtureSource(mode: FixtureMode, root: string): string {
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
vi.mock("playwright", () => {
const acquire = async () => {
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
};
return { chromium: { launch: acquire, connect: acquire } };
});
import { createControlUiE2eSuite, holdModuleResponse } from ${JSON.stringify(helperPath)};
process.env.OPENCLAW_UI_E2E_DIAGNOSTIC_DIR = ${JSON.stringify(path.join(root, "diagnostics"))};
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
