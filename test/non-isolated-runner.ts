// Non-isolated runner helps execute tests without Vitest isolation.
import path from "node:path";
import type {
  EvaluatedModuleNode as ViteEvaluatedModuleNode,
  EvaluatedModules as ViteEvaluatedModules,
} from "vite/module-runner";
import { TestRunner, type RunnerTask, type RunnerTestFile, type TestTryOptions, vi } from "vitest";
import { resetAgentEventsForTest } from "../src/infra/agent-events.js";
import { loggingState } from "../src/logging/state.js";
import { clearNamedPluginRuntimeStoresForTest } from "../src/plugin-sdk/runtime-store-registry.js";
import {
  isGatewayWorkAdmissionClosed,
  markGatewayRestartDraining,
  resetGatewayWorkAdmission,
} from "../src/process/gateway-work-admission.js";
import { drainGlobalSingletonLifecycleState } from "../src/shared/global-singleton.js";
import {
  type CustomElementTracking,
  dropRepoOwnedCustomElements,
  trackCustomElementRegistry,
} from "./jsdom-custom-elements.ts";
import { repositoryTestApiPublications } from "./repository-test-api-publications.ts";

type EvaluatedModuleNode = ViteEvaluatedModuleNode & {
  mockedExports?: unknown;
};

type EvaluatedModules = {
  idToModuleMap: Map<string, EvaluatedModuleNode>;
  invalidateModule: ViteEvaluatedModules["invalidateModule"];
  [RETIRED_TEST_API_EXECUTIONS]?: WeakSet<ModuleExecution>;
};

// Vitest's public worker type leaves execution entries untyped; mirror the
// evaluator's external flag without importing an unexported package subpath.
type ModuleExecution = { external?: boolean };
type ModuleExecutionInfo = Map<string, ModuleExecution>;

type ModuleMocker = {
  reset?: () => void;
  pendingMockResolution: Promise<void>;
};

type TestRunnerInternals = {
  moduleRunner?: { mocker?: ModuleMocker };
  workerState: { evaluatedModules: unknown; moduleExecutionInfo: ModuleExecutionInfo };
};

const SHARED_TEST_SETUP = Symbol.for("openclaw.sharedTestSetup");
const RETIRED_TEST_API_EXECUTIONS = Symbol.for("openclaw.retiredTestApiExecutions");
const EMBEDDED_RUN_STATE = Symbol.for("openclaw.embeddedRunState");
const REPLY_RUN_REGISTRY = Symbol.for("openclaw.replyRunRegistry");
const DIAGNOSTIC_EVENTS_STATE = Symbol.for("openclaw.diagnosticEvents.state.v1");
const DIAGNOSTIC_EVENT_LISTENER_PRESENCE = Symbol.for(
  "openclaw.diagnosticEventListenerPresence.v1",
);
const SESSION_SUSPENSION_TEST_API = Symbol.for("openclaw.sessionSuspensionTestApi");
const SECRET_REDACTION_TEST_API = Symbol.for("openclaw.secretRedactionRegistryTestApi");
// Shared-worker scoped: the registry lives on the worker global, not in the module graph.
const CUSTOM_ELEMENT_TRACKING = Symbol.for("openclaw.nonIsolatedCustomElementTracking");
const nativeConsoleMethods = {
  log: console.log,
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
  trace: console.trace,
};
// loggingState is keyed off globalThis precisely so it survives module reloads,
// so vi.resetModules() below cannot undo what a file latched into it.
const baselineLoggingState = { ...loggingState };
const nativeTimerGlobals = {
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
  setImmediate: globalThis.setImmediate,
  clearImmediate: globalThis.clearImmediate,
  Date: globalThis.Date,
};

function getSharedTestHome(): string | undefined {
  const globalState = globalThis as typeof globalThis & {
    [SHARED_TEST_SETUP]?: { tempHome?: string };
  };
  return globalState[SHARED_TEST_SETUP]?.tempHome ?? process.env.OPENCLAW_TEST_HOME;
}

function resetEvaluatedModules(modules: EvaluatedModules, executions: ModuleExecutionInfo) {
  const skipPaths = [/\/vitest\/dist\//, /vitest-virtual-\w+\/dist/u, /@vitest\/dist/u];
  // Vitest reuses the graph across runner instances. Weak marks prevent a past
  // execution from owning a later mock-only slot without retaining any records
  // or changing Vitest's timing/coverage data; each evaluation gets a new record.
  const retiredExecutions = (modules[RETIRED_TEST_API_EXECUTIONS] ??= new WeakSet());

  modules.idToModuleMap.forEach((node, modulePath) => {
    if (skipPaths.some((pattern) => pattern.test(modulePath))) {
      return;
    }
    // importActual can execute a source then replace its meta with a mock placeholder.
    // Vitest's evaluator records each execution independently (including native ones),
    // using the unprefixed id for automocks. Module resets preserve those records.
    const key = repositoryTestApiPublications.get(node.file);
    const executionId = node.id.startsWith("mock:") ? node.id.slice(5) : node.id;
    const execution = executions.get(executionId);
    if (key && execution && !execution.external && !retiredExecutions.has(execution)) {
      retiredExecutions.add(execution);
      const publication = Object.getOwnPropertyDescriptor(globalThis, key);
      if (publication?.configurable && "value" in publication) {
        Reflect.deleteProperty(globalThis, key);
      }
    }
    // Mock metadata owns factories and cached exports after the registry resets.
    // Retire those nodes while preserving ordinary transformed-code metadata.
    if (modulePath.startsWith("mock:") || (node.meta && "mockedModule" in node.meta)) {
      modules.invalidateModule(node);
      node.mockedExports = undefined;
    } else {
      node.promise = undefined;
      node.exports = undefined;
      node.evaluated = false;
    }
    node.importers.clear();
  });
}

function restoreSharedTestHomeAfterEnvUnstub(testHomeRaw: string | undefined): void {
  const testHome = testHomeRaw?.trim();
  if (!testHome) {
    return;
  }

  process.env.HOME = testHome;
  process.env.USERPROFILE = testHome;
  process.env.OPENCLAW_TEST_HOME = testHome;
  delete process.env.OPENCLAW_CONFIG_PATH;
  delete process.env.OPENCLAW_STATE_DIR;
  delete process.env.OPENCLAW_AGENT_DIR;
  delete process.env.PI_CODING_AGENT_DIR;
  process.env.XDG_CONFIG_HOME = path.join(testHome, ".config");
  process.env.XDG_DATA_HOME = path.join(testHome, ".local", "share");
  process.env.XDG_STATE_HOME = path.join(testHome, ".local", "state");
  process.env.XDG_CACHE_HOME = path.join(testHome, ".cache");
}

function customElementTrackingStore(): Record<PropertyKey, unknown> & {
  customElements?: CustomElementRegistry;
  [CUSTOM_ELEMENT_TRACKING]?: CustomElementTracking;
} {
  return globalThis;
}

function installCustomElementTracking(): void {
  const globalStore = customElementTrackingStore();
  const registry = globalStore.customElements;
  // Re-track when the lane switches back to a fresh jsdom window: the previous
  // tracking would hold a dead definitions array and stop dropping stale classes.
  if (!registry || globalStore[CUSTOM_ELEMENT_TRACKING]?.registry === registry) {
    return;
  }
  globalStore[CUSTOM_ELEMENT_TRACKING] = trackCustomElementRegistry(registry);
}

function dropTrackedRepoOwnedCustomElements(): void {
  const tracking = customElementTrackingStore()[CUSTOM_ELEMENT_TRACKING];
  if (tracking) {
    dropRepoOwnedCustomElements(tracking);
  }
}

// The shared jsdom window keeps whatever the previous file mounted. Test helpers
// that look up `document.body.querySelector(...)` then answer the earlier file's
// leaked dialog instead of the one under test, and focus assertions read its stale
// activeElement. File-scoped DOM has to die with the file, like the module graph.
// `document.head` is left alone: externalized dependency styles register once per
// worker and cannot be replayed.
function resetSharedDocumentBody(): void {
  const body = (globalThis as { document?: Document }).document?.body;
  if (!body) {
    return;
  }
  body.replaceChildren();
  for (const attribute of body.getAttributeNames()) {
    body.removeAttribute(attribute);
  }
  // jsdom can retain detached shadow focus even after the fixture removes its DOM.
  // Focus body to clear it, then blur while focusable to restore fresh-document state.
  body.tabIndex = -1;
  body.focus();
  body.blur();
  body.removeAttribute("tabindex");
}

function restoreRealTimers(): void {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
}

function restoreNativeTimerGlobals(): void {
  Object.assign(globalThis, nativeTimerGlobals);
}

// enableConsoleCapture() swaps every console method for a forwarder and latches
// routing that production only unwinds at process exit (stdio MCP servers, `--json`
// one-shot commands), so a shared worker carries both into the next file. That
// forwarder writes to process.stderr once forceConsoleToStderr is latched, and the
// next file's console spy then records nothing.
function restoreConsoleRoutingState(): void {
  Object.assign(console, nativeConsoleMethods);
  // The EPIPE handlers really are attached to the worker's stdout/stderr; resetting
  // this flag would let the next enableConsoleCapture() stack a second pair.
  const { streamErrorHandlersInstalled } = loggingState;
  Object.assign(loggingState, baselineLoggingState, { streamErrorHandlersInstalled });
}

function restoreMocksThenRealTimers(): void {
  // A spy created while fake timers are active captures the fake timer as its
  // "original" implementation. Restore spies first, then swap timers back.
  vi.restoreAllMocks();
  restoreRealTimers();
  restoreNativeTimerGlobals();
}

type CleanupAction = () => void;

type EmbeddedRunHandle = {
  abort?: () => void;
  cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
};

type EmbeddedRunWaiter = {
  timer?: NodeJS.Timeout;
  resolve?: (ended: boolean) => void;
};

type EmbeddedRunStateForTest = {
  activeRuns?: Map<unknown, EmbeddedRunHandle>;
  snapshots?: Map<unknown, unknown>;
  sessionIdsByKey?: Map<unknown, unknown>;
  sessionIdsByFile?: Map<unknown, unknown>;
  abandonedRunsBySessionId?: Map<unknown, unknown>;
  abandonedRunSessionIdsByKey?: Map<unknown, unknown>;
  abandonedRunSessionIdsByFile?: Map<unknown, unknown>;
  waiters?: Map<unknown, Set<EmbeddedRunWaiter>>;
  modelSwitchRequests?: Map<unknown, unknown>;
};

type ReplyRunWaiter = {
  finish?: (ended: boolean) => void;
};

type ReplyRunOperation = {
  abortForRestart?: () => void;
};

type ReplyRunStateForTest = {
  activeRunsByKey?: Map<unknown, ReplyRunOperation>;
  activeSessionIdsByKey?: Map<unknown, unknown>;
  activeKeysBySessionId?: Map<unknown, unknown>;
  waitKeysBySessionId?: Map<unknown, unknown>;
  waitersByKey?: Map<unknown, Set<ReplyRunWaiter>>;
};

type DiagnosticEventsStateForTest = {
  listeners?: Set<unknown>;
  trustedListeners?: Set<unknown>;
  toolExecutionListeners?: Set<unknown>;
  asyncQueue?: unknown[];
};

type SessionSuspensionTestApi = {
  resetSessionSuspensionStateForTest?: () => void;
};

type SecretRedactionTestApi = {
  resetSecretRedactionRegistryForTest?: () => void;
};

function runCleanupActions(actions: CleanupAction[]): unknown {
  let firstError: unknown;
  for (const action of actions) {
    try {
      action();
    } catch (error) {
      firstError ??= error;
    }
  }
  return firstError;
}

function resetOpenClawGlobalRunState(): void {
  const cleanupActions: CleanupAction[] = [];
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const embeddedRunState = globalStore[EMBEDDED_RUN_STATE] as EmbeddedRunStateForTest | undefined;
  for (const handle of embeddedRunState?.activeRuns?.values() ?? []) {
    cleanupActions.push(() => {
      if (handle.cancel) {
        handle.cancel("restart");
        return;
      }
      handle.abort?.();
    });
  }
  for (const waiters of embeddedRunState?.waiters?.values() ?? []) {
    for (const waiter of waiters) {
      cleanupActions.push(() => {
        if (waiter.timer) {
          clearTimeout(waiter.timer);
        }
        waiter.resolve?.(true);
      });
    }
  }

  const replyRunState = globalStore[REPLY_RUN_REGISTRY] as ReplyRunStateForTest | undefined;
  for (const operation of replyRunState?.activeRunsByKey?.values() ?? []) {
    cleanupActions.push(() => {
      operation.abortForRestart?.();
    });
  }
  for (const waiters of replyRunState?.waitersByKey?.values() ?? []) {
    for (const waiter of waiters) {
      cleanupActions.push(() => {
        waiter.finish?.(false);
      });
    }
  }

  const cleanupError = runCleanupActions(cleanupActions);
  if (cleanupError) {
    // oxlint-disable-next-line typescript/only-throw-error -- cleanup hooks may throw their original non-Error value; preserve that test-runner behavior.
    throw cleanupError;
  }

  embeddedRunState?.activeRuns?.clear();
  embeddedRunState?.snapshots?.clear();
  embeddedRunState?.sessionIdsByKey?.clear();
  embeddedRunState?.sessionIdsByFile?.clear();
  embeddedRunState?.abandonedRunsBySessionId?.clear();
  embeddedRunState?.abandonedRunSessionIdsByKey?.clear();
  embeddedRunState?.abandonedRunSessionIdsByFile?.clear();
  embeddedRunState?.waiters?.clear();
  embeddedRunState?.modelSwitchRequests?.clear();

  replyRunState?.activeRunsByKey?.clear();
  replyRunState?.activeSessionIdsByKey?.clear();
  replyRunState?.activeKeysBySessionId?.clear();
  replyRunState?.waitKeysBySessionId?.clear();
  replyRunState?.waitersByKey?.clear();
}

function resetOpenClawGlobalDiagnosticState(): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = globalStore[DIAGNOSTIC_EVENTS_STATE] as DiagnosticEventsStateForTest | undefined;
  // The dispatcher intentionally survives module reloads. Mirror isolate mode
  // without duplicating its private state defaults in the test runner.
  state?.listeners?.clear();
  state?.trustedListeners?.clear();
  state?.toolExecutionListeners?.clear();
  state?.asyncQueue?.splice(0);
  Reflect.deleteProperty(globalStore, DIAGNOSTIC_EVENTS_STATE);
  // The listener-presence mirror is a separate globalThis record; clearing the
  // sets above without zeroing it leaves hasInternalDiagnosticEventListeners()
  // true for the next file (e.g. an import-time registration like
  // diagnostic-run-activity.ts whose stop handle died with the module registry).
  const presence = globalStore[DIAGNOSTIC_EVENT_LISTENER_PRESENCE] as
    | { internalCount?: number; trustedCount?: number }
    | undefined;
  if (presence) {
    presence.internalCount = 0;
    presence.trustedCount = 0;
  }
}

function resetOpenClawSessionSuspensionState(): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const api = globalStore[SESSION_SUSPENSION_TEST_API] as SessionSuspensionTestApi | undefined;
  api?.resetSessionSuspensionStateForTest?.();
}

function resetOpenClawSecretRedactionState(): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const api = globalStore[SECRET_REDACTION_TEST_API] as SecretRedactionTestApi | undefined;
  api?.resetSecretRedactionRegistryForTest?.();
}

// Join the native owner's latest pass, including imports queued while cleanup waits.
async function drainMockerResolveMocks(mocker: ModuleMocker | undefined): Promise<void> {
  if (!mocker) {
    return;
  }
  while (true) {
    const tail = mocker.pendingMockResolution;
    await tail;
    if (mocker.pendingMockResolution === tail) {
      return;
    }
  }
}

export default class OpenClawNonIsolatedRunner extends TestRunner {
  override onCollectStart(file: RunnerTestFile) {
    super.onCollectStart(file);
    if (!this.config.isolate) {
      installCustomElementTracking();
    }
    restoreRealTimers();
    restoreNativeTimerGlobals();
    restoreSharedTestHomeAfterEnvUnstub(getSharedTestHome());
  }

  override async onBeforeRunTask(test: RunnerTask) {
    restoreRealTimers();
    restoreNativeTimerGlobals();
    await super.onBeforeRunTask(test);
  }

  override onBeforeTryTask(test: RunnerTask, options: TestTryOptions) {
    restoreRealTimers();
    restoreNativeTimerGlobals();
    super.onBeforeTryTask(test, options);
  }

  // Cross-file cleanup lives in onAfterRunFiles, not onAfterRunSuite: vitest
  // early-returns runSuite for files that failed during collection (and for
  // skipped file suites) without firing onAfterRunSuite, which used to leave
  // the crashed file's evaluated real modules cached in the shared worker so
  // the next file's vi.mock factories silently never applied. The worker loop
  // calls startTests per file, so this hook runs after every file regardless
  // of its collect/run outcome.
  // oxlint-disable-next-line typescript/no-misused-promises -- Vitest awaits this hook; its concrete TestRunner declaration narrows the return to void.
  override async onAfterRunFiles(files: RunnerTestFile[]) {
    super.onAfterRunFiles(files);
    const internals = this as unknown as TestRunnerInternals;
    await drainMockerResolveMocks(internals.moduleRunner?.mocker);

    // Mirror the missing cleanup from Vitest isolate mode so shared workers do
    // not carry file-scoped timers, stubs, spies, or stale module state
    // forward into the next file.
    restoreMocksThenRealTimers();
    restoreConsoleRoutingState();
    vi.unstubAllGlobals();
    const testHome = getSharedTestHome();
    vi.unstubAllEnvs();
    restoreSharedTestHomeAfterEnvUnstub(testHome);
    vi.clearAllMocks();
    // Reject suspended admission waiters before async cleanup. The final reset
    // reopens admission only after those old waiters have observed this fence.
    if (isGatewayWorkAdmissionClosed()) {
      markGatewayRestartDraining();
    }
    resetOpenClawGlobalRunState();
    resetAgentEventsForTest();
    resetOpenClawGlobalDiagnosticState();
    resetOpenClawSessionSuspensionState();
    // Lifecycle-owned singletons survive module resets; close them before the next file
    // can observe a previous file's sessions, caches, or registered resources.
    await drainGlobalSingletonLifecycleState();
    // Teardown can still register or log secrets; retire them only after its writers settle.
    resetOpenClawSecretRedactionState();
    if (this.config.isolate) {
      return;
    }
    // Named plugin runtimes intentionally survive duplicate module evaluation in production.
    // Clear their shared slots here so one test file cannot lend a partial runtime to the next.
    clearNamedPluginRuntimeStoresForTest();
    dropTrackedRepoOwnedCustomElements();
    resetSharedDocumentBody();
    // Gateway admission survives production close. Retire file-owned roots after
    // runtime cleanup, before another file can inherit their leases or drain fence.
    resetGatewayWorkAdmission();
    vi.resetModules();
    internals.moduleRunner?.mocker?.reset?.();
    resetEvaluatedModules(
      internals.workerState.evaluatedModules as EvaluatedModules,
      internals.workerState.moduleExecutionInfo,
    );
  }
}
