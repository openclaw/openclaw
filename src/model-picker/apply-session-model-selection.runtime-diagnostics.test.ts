import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getPublishedPreparedModelCatalogOwnerSnapshot } from "../agents/prepared-model-catalog.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  publishPreparedModelRuntimeSnapshot,
} from "../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../agents/prepared-model-runtime.test-support.js";
import {
  loadSessionEntryReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runWithDiagnosticTraceContext } from "../infra/diagnostic-trace-context.js";
import { registerDiagnosticTracePropagationBridge } from "../infra/diagnostic-trace-propagation.js";
import {
  getDiagnosticStabilitySnapshot,
  resetDiagnosticStabilityRecorderForTest,
  startDiagnosticStabilityRecorder,
} from "../logging/diagnostic-stability.js";
import {
  emitDiagnosticEvent,
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "../plugin-sdk/diagnostic-runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { applySessionModelSelection } from "./apply-session-model-selection.js";

// Only unrelated post-commit notifications are replaced. Owner publication, auth,
// runtime preparation, both native guards, and the SQLite session write are real.
vi.mock("../infra/system-events.js", () => ({ enqueueSystemEvent: vi.fn() }));
vi.mock("../auto-reply/reply/queue.js", () => ({ refreshQueuedFollowupSession: vi.fn() }));
vi.mock("../gateway/session-patch-hooks.js", () => ({ triggerSessionPatchHook: vi.fn() }));

const provider = "runtime-diagnostic-fixture";
const model = "fixture-model";
const profile = "runtime-diagnostic-private-profile";
const credential = "synthetic-runtime-diagnostic-credential";
const sessionKey = "agent:main:runtime-diagnostic-private-session";
const catalog = [
  { provider, id: model, name: "Fixture model", contextWindow: 32000, reasoning: false },
];
type ChoiceEvent = Extract<DiagnosticEventPayload, { type: "model.runtime_choice" }>;

// A consumer example deliberately accepts only the catalog-backed success path
// it can prove. Unknown or incomplete evidence never becomes an accepted guard.
function collectReadyCatalogGuard(value: unknown) {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const event = value as Record<string, unknown>;
  if (
    event.type !== "model.runtime_choice" ||
    event.version !== 1 ||
    event.phase !== "validate" ||
    event.outcome !== "ready" ||
    event.reason !== "ready" ||
    !event.checks ||
    typeof event.checks !== "object"
  ) {
    return undefined;
  }
  const checks = event.checks as Record<string, unknown>;
  if (
    checks.ownerLookup !== "present" ||
    checks.authStore !== "present" ||
    checks.catalogPresence !== "present" ||
    checks.offCatalogAuth !== "not-reached" ||
    checks.offCatalogAuthMode !== "not-reached" ||
    checks.offCatalogResolution !== "not-reached" ||
    checks.runtimeEligibility !== "eligible" ||
    checks.commitOwnerFreshness !== "current" ||
    checks.nativeAvailability !== "available"
  ) {
    return undefined;
  }
  return {
    version: 1,
    phase: "validate",
    outcome: "ready",
    reason: "ready",
    checks: {
      ownerLookup: "present",
      authStore: "present",
      catalogPresence: "present",
      offCatalogAuth: "not-reached",
      offCatalogAuthMode: "not-reached",
      offCatalogResolution: "not-reached",
      runtimeEligibility: "eligible",
      commitOwnerFreshness: "current",
      nativeAvailability: "available",
    },
  };
}

describe("native model selection runtime diagnostics", () => {
  let state: OpenClawTestState;
  let config: OpenClawConfig;
  let entry: SessionEntry;
  let events: ChoiceEvent[];
  let unsubscribe: () => void;

  beforeEach(async () => {
    state = await createOpenClawTestState({
      label: "runtime-choice-diagnostics",
      env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
    });
    config = {
      plugins: { enabled: false },
      agents: {
        defaults: { workspace: state.workspaceDir, model: { primary: provider + "/" + model } },
      },
      models: {
        providers: {
          [provider]: {
            api: "openai-completions",
            baseUrl: "https://runtime-diagnostic.invalid/v1",
            models: [
              {
                id: model,
                name: "Fixture model",
                reasoning: false,
                input: ["text"],
                contextWindow: 32000,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      },
    };
    await state.writeConfig(config);
    await state.writeAuthProfiles({
      version: 1,
      profiles: {
        [profile]: { type: "api_key", provider, key: credential },
      },
    });
    entry = {
      sessionId: "runtime-diagnostic-private-id",
      updatedAt: 1,
      delivery: { kind: "none" },
    };
    await replaceSessionEntry({ agentId: "main", sessionKey }, entry);
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toEqual(entry);
    resetDiagnosticEventsForTest();
    events = [];
    unsubscribe = onInternalDiagnosticEvent(
      (event, metadata) => {
        if (metadata.trusted && event.type === "model.runtime_choice") {
          events.push(event);
        }
      },
      { include: ["model.runtime_choice"] },
    );
  });

  afterEach(async () => {
    await waitForDiagnosticEventsDrained();
    unsubscribe();
    resetDiagnosticEventsForTest();
    resetDiagnosticStabilityRecorderForTest();
    await resetPreparedModelRuntimeSnapshotsForTest();
    vi.restoreAllMocks();
    await state.cleanup();
  });

  async function publish() {
    const owner = await publishPreparedModelRuntimeSnapshot(
      {
        config,
        agentId: "main",
        agentDir: state.agentDir(),
        workspaceDir: state.workspaceDir,
        env: state.env,
      },
      { provenance: "configured", catalogMode: "static" },
    );
    expect(getPublishedPreparedModelCatalogOwnerSnapshot({ config, agentId: "main" })).toBe(owner);
    return owner;
  }

  function select(validateAuthProfileSelection?: () => string | undefined) {
    return applySessionModelSelection({
      cfg: config,
      agentId: "main",
      sessionKey,
      storePath: state.sessionsDir() + "/sessions.json",
      sessionEntry: entry,
      sessionStore: { [sessionKey]: entry },
      defaultProvider: provider,
      defaultModel: "previous-model",
      currentProvider: provider,
      currentModel: "previous-model",
      modelCatalog: catalog,
      thinkingCatalog: catalog,
      canPersistStickyModelSelection: false,
      validateAuthProfileSelection,
      request: { provider, model, isDefault: false, runtime: { kind: "set", runtime: "openclaw" } },
      markLiveSwitchPending: true,
    });
  }

  it("captures the real accepted prepare and both guards without exposing private inputs", async () => {
    await publish();
    const publicEvents: DiagnosticEventPayload[] = [];
    const stopPublic = onDiagnosticEvent((event) => publicEvents.push(event));
    expect(await select()).toMatchObject({ status: "applied", agentRuntime: "openclaw" });
    await waitForDiagnosticEventsDrained();
    stopPublic();
    expect(events.map(({ phase, outcome, reason }) => ({ phase, outcome, reason }))).toEqual([
      { phase: "prepare", outcome: "ready", reason: "ready" },
      { phase: "validate", outcome: "ready", reason: "ready" },
      { phase: "validate", outcome: "ready", reason: "ready" },
    ]);
    expect(events[0]?.checks).toEqual({
      ownerLookup: "present",
      authStore: "present",
      catalogPresence: "present",
      offCatalogAuth: "not-reached",
      offCatalogAuthMode: "not-reached",
      offCatalogResolution: "not-reached",
      runtimeEligibility: "eligible",
      commitOwnerFreshness: "not-reached",
      nativeAvailability: "not-reached",
    });
    expect(events[2]?.checks).toEqual({
      ...events[0]?.checks,
      commitOwnerFreshness: "current",
      nativeAvailability: "available",
    });
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toMatchObject({
      modelOverride: model,
      agentRuntimeOverride: "openclaw",
    });
    expect(publicEvents.filter((event) => event.type === "model.runtime_choice")).toEqual([]);
    for (const value of [
      provider,
      model,
      profile,
      credential,
      sessionKey,
      entry.sessionId,
      state.root,
    ]) {
      expect(JSON.stringify(events)).not.toContain(value);
    }
  });

  it("records owner refusal and leaves the native session unchanged", async () => {
    const before = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
    expect(await select()).toEqual({
      status: "rejected",
      reason: "invalid-runtime",
      message:
        'Runtime "openclaw" is not available for ' +
        provider +
        "/" +
        model +
        ". Refresh the model catalog and choose again.",
    });
    await waitForDiagnosticEventsDrained();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      phase: "prepare",
      outcome: "unavailable",
      reason: "owner-missing",
    });
    expect(events[0]?.checks).toEqual({
      ownerLookup: "absent",
      authStore: "not-reached",
      catalogPresence: "not-reached",
      offCatalogAuth: "not-reached",
      offCatalogAuthMode: "not-reached",
      offCatalogResolution: "not-reached",
      runtimeEligibility: "not-reached",
      commitOwnerFreshness: "not-reached",
      nativeAvailability: "not-reached",
    });
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toEqual(before);
    expect(entry).toEqual(before);
  });

  it("records commit revocation without evaluating native availability or mutating the session", async () => {
    await publish();
    const before = loadSessionEntryReadOnly({ agentId: "main", sessionKey });
    let guards = 0;
    const result = await select(() => {
      if (++guards === 2) {
        markPreparedModelRuntimeSnapshotsStale("synthetic commit revocation");
      }
      return undefined;
    });
    expect(result).toMatchObject({ status: "rejected", reason: "not-allowed" });
    expect(guards).toBe(2);
    await waitForDiagnosticEventsDrained();
    expect(events.map(({ phase, reason }) => ({ phase, reason }))).toEqual([
      { phase: "prepare", reason: "ready" },
      { phase: "validate", reason: "ready" },
      { phase: "validate", reason: "owner-stale" },
    ]);
    expect(events[2]?.checks).toMatchObject({
      commitOwnerFreshness: "stale",
      nativeAvailability: "not-reached",
    });
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toEqual(before);
    expect(entry).toEqual(before);
  });

  it("contains throwing observers and delivers no observer inline with the final guard", async () => {
    await publish();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prepareEvent = vi.fn();
    const shouldPrepareEvent = vi.fn(
      (event: { type: string }) => event.type === "model.runtime_choice",
    );
    const stopBridge = registerDiagnosticTracePropagationBridge({
      prepareEvent,
      shouldPrepareEvent,
      resolveTraceContext: (trace) => trace,
    });
    let inGuard = false;
    let inlineObservers = 0;
    const stop = onInternalDiagnosticEvent(
      (event) => {
        if (event.type !== "model.runtime_choice") {
          return;
        }
        if (inGuard) {
          inlineObservers += 1;
        }
        throw new Error("synthetic diagnostic observer failure");
      },
      { include: ["model.runtime_choice"] },
    );
    const result = await select(() => {
      inGuard = true;
      queueMicrotask(() => {
        inGuard = false;
      });
      return undefined;
    });
    expect(result).toMatchObject({ status: "applied" });
    await waitForDiagnosticEventsDrained();
    stop();
    expect(events).toHaveLength(3);
    expect(errors).toHaveBeenCalled();
    expect(inlineObservers).toBe(0);
    stopBridge();
    expect(prepareEvent).not.toHaveBeenCalled();
    expect(
      shouldPrepareEvent.mock.calls.some(([event]) => event.type === "model.runtime_choice"),
    ).toBe(false);
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey })).toMatchObject({
      modelOverride: model,
    });
  });

  it("projects only closed facts and rejects incomplete real producer evidence", async () => {
    await publish();
    const trace = { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" };
    await runWithDiagnosticTraceContext(trace, () => select());
    await waitForDiagnosticEventsDrained();
    const guard = events[2]!;
    expect(guard.trace).toEqual(trace);
    const projected = collectReadyCatalogGuard(guard);
    expect(projected).toBeDefined();
    expect(JSON.stringify(projected)).not.toContain(trace.traceId);
    expect(projected).not.toHaveProperty("seq");
    expect(projected).not.toHaveProperty("ts");
    for (const field of ["reason", "phase", "outcome", "version", "checks"]) {
      const incomplete = { ...guard } as Record<string, unknown>;
      delete incomplete[field];
      expect(collectReadyCatalogGuard(incomplete)).toBeUndefined();
    }
    for (const field of Object.keys(guard.checks)) {
      const checks = { ...guard.checks } as Record<string, unknown>;
      delete checks[field];
      expect(collectReadyCatalogGuard({ ...guard, checks })).toBeUndefined();
    }
    expect(collectReadyCatalogGuard({ ...guard, reason: "future-reason" })).toBeUndefined();
    expect(
      collectReadyCatalogGuard({
        ...guard,
        checks: { ...guard.checks, nativeAvailability: "not-reached" },
      }),
    ).toBeUndefined();
    expect(collectReadyCatalogGuard(events[0])).toBeUndefined();
    expect(
      collectReadyCatalogGuard({
        ...guard,
        privateValue: credential,
        checks: { ...guard.checks, privateValue: profile },
      }),
    ).toEqual(projected);
  });

  it("keeps guard facts out of stability snapshots and ignores untrusted decision input", async () => {
    startDiagnosticStabilityRecorder();
    await publish();
    await select();
    await waitForDiagnosticEventsDrained();
    const accepted = events[0]!;
    expect(getDiagnosticStabilitySnapshot({ type: "model.runtime_choice" }).count).toBe(0);
    events.length = 0;
    emitDiagnosticEvent(accepted);
    await waitForDiagnosticEventsDrained();
    expect(events).toEqual([]);
    expect(getDiagnosticStabilitySnapshot({ type: "model.runtime_choice" }).count).toBe(0);
  });
});
