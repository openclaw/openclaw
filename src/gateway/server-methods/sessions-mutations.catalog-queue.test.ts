import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { loadPublishedPreparedModelCatalogOwnerSnapshot } from "../../agents/prepared-model-catalog.js";
import {
  markPreparedModelRuntimeSnapshotsStale,
  rejectPendingPreparedModelRuntimeReplacement,
} from "../../agents/prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "../../agents/prepared-model-runtime.test-support.js";
import { makeProviderModelFixture } from "../../agents/test-helpers/provider-model-fixture.js";
import { setRuntimeConfigSnapshot, type OpenClawConfig } from "../../config/config.js";
import { captureRuntimeConfigAsyncReader } from "../../config/io.runtime.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as sessionLifecycle from "../../sessions/session-controller.lifecycle.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { closeOpenClawAgentDatabasesForTest } from "../../state/openclaw-agent-db.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { loadGatewayModelCatalog as loadActualGatewayModelCatalog } from "../server-model-catalog.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import {
  createSessionMutationContext,
  startSessionMutationRequest,
} from "./sessions-mutations.native-consent.test-support.js";
import { createSessionMutationTestClient } from "./sessions-mutations.owner.test-support.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

function expectSuccess(respond: ReturnType<typeof vi.fn>, result: unknown = expect.any(Object)) {
  expect(respond).toHaveBeenCalledWith(true, result, undefined);
}

function expectFailure(respond: ReturnType<typeof vi.fn>, error: unknown) {
  expect(respond).toHaveBeenCalledWith(false, undefined, error);
}

function expectBatch(respond: ReturnType<typeof vi.fn>, outcomes: unknown) {
  expect(respond).toHaveBeenCalledExactlyOnceWith(true, { outcomes }, undefined);
}

const unexpectedFailure = {
  code: "UNAVAILABLE",
  message: "Session patch failed unexpectedly. Retry the request.",
  retryable: true,
};

function inState(run: (state: OpenClawTestState) => Promise<void>, prepare = true) {
  return () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      if (prepare) {
        await captureRuntimeConfigAsyncReader()();
      }
      await run(state);
    });
}

function pausedCatalog(calls = 1) {
  const entered = createDeferredCore();
  const catalog =
    createDeferredCore<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
  const load = vi.fn(() => {
    if (load.mock.calls.length === calls) {
      entered.resolve();
    }
    return catalog.promise;
  });
  return { entered, catalog, load };
}

function diagnostics() {
  let clock = performance.now();
  const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
  const records: Array<{ traceId: string | undefined; message: string }> = [];
  const log = vi.spyOn(sessionLog, "info").mockImplementation((message) => {
    if (message.startsWith("slow session patch ")) {
      records.push({ traceId: getActiveDiagnosticTraceContext()?.traceId, message });
    }
  });
  return {
    records,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
    restore() {
      clockSpy.mockRestore();
      log.mockRestore();
    },
  };
}

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  closeOpenClawAgentDatabasesForTest();
});

const patchContext = (
  load: GatewayRequestContext["loadGatewayModelCatalog"],
  cfg: OpenClawConfig = {},
) => createSessionMutationContext(cfg, load);

async function modelContext(state: OpenClawTestState, store: string) {
  const model = makeProviderModelFixture<"openai-completions">({
    provider: "openai",
    id: "gpt-5.6-sol",
    api: "openai-completions",
    baseUrl: "https://fixture.invalid/v1",
  });
  const cfg: OpenClawConfig = {
    models: {
      providers: {
        openai: {
          api: model.api,
          baseUrl: model.baseUrl,
          models: [model, { ...model, id: "gpt-5.5", name: "GPT-5.5" }].map(
            ({ provider: _provider, ...definition }) => definition,
          ),
        },
      },
    },
    agents: {
      defaults: { model: "openai/gpt-5.5" },
      ownership: "explicit",
      entries: { main: {}, work: {} },
    },
    session: { store },
  };
  await state.writeConfig(cfg);
  setRuntimeConfigSnapshot(cfg);
  return patchContext(async () => [model], cfg);
}

function patchRequest(
  context: GatewayRequestContext,
  method: "sessions.patch" | "sessions.patchMany" = "sessions.patch",
) {
  return (
    params: Record<string, unknown>,
    respond: GatewayRequestHandlerOptions["respond"],
    sessionMutationAuthorization?: GatewayRequestHandlerOptions["sessionMutationAuthorization"],
  ) =>
    startSessionMutationRequest(method, params, {
      req: { type: "req", id: "patch", method, params },
      respond,
      context,
      client: null,
      isWebchatConnect: () => false,
      sessionMutationAuthorization,
    }).running;
}

function readEntry(sessionKey: string, agentId = "main", storePath?: string) {
  return loadSessionEntry({ agentId, sessionKey, storePath });
}

function expectEntry(
  key: string,
  fields: Partial<SessionEntry>,
  absent: (keyof SessionEntry)[] = [],
) {
  const entry = readEntry(key);
  expect(entry).toMatchObject(fields);
  for (const field of absent) {
    expect(entry?.[field]).toBeUndefined();
  }
}

function seedEntry(sessionKey: string, agentId = "main", entry: Partial<SessionEntry> = {}) {
  return upsertSessionEntryCore(
    { agentId, sessionKey },
    { sessionId: sessionKey, updatedAt: 1, ...entry },
  );
}

test.each(["sessions.patch", "sessions.patchMany"] as const)(
  "%s bounds a stalled catalog without committing and permits retry",
  (method) =>
    inState(async () => {
      const targets = (method === "sessions.patchMany" ? ["first", "second"] : ["first"]).map(
        (name) => ({ key: `agent:main:catalog-deadline-${name}` }),
      );
      for (const { key } of targets) {
        await seedEntry(key);
      }
      const entries = () => targets.map(({ key }) => readEntry(key));
      const before = entries();
      const { entered, catalog, load } = pausedCatalog();
      const context = patchContext(load);
      const respond = vi.fn();
      const patch = { thinkingLevel: "low", pinned: true };
      const params =
        method === "sessions.patchMany" ? { targets, patch } : { ...targets[0], ...patch };
      const invoke = () => patchRequest(context, method)(params, respond);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
      const pending = invoke();
      try {
        await Promise.race([entered.promise, pending]);
        await vi.advanceTimersByTimeAsync(20_000);
        catalog.resolve([]);
        await pending;
        const unavailable = expect.objectContaining({
          code: "UNAVAILABLE",
          retryable: true,
          message: expect.stringMatching(/model catalog.*loading.*retry/i),
        });
        expect(respond).toHaveBeenCalledExactlyOnceWith(
          ...(method === "sessions.patchMany"
            ? [
                true,
                {
                  outcomes: targets.map(({ key }) => ({ key, ok: false, error: unavailable })),
                },
                undefined,
              ]
            : [false, undefined, unavailable]),
        );
        expect(entries()).toEqual(before);
      } finally {
        vi.useRealTimers();
        catalog.resolve([]);
        await pending;
      }
      respond.mockClear();
      await invoke();
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      for (const entry of entries()) {
        expect(entry).toMatchObject({ thinkingLevel: "low", pinnedAt: expect.any(Number) });
      }
    })(),
);

test(
  "catalog reload releases the agent writer while preserving same-session ordering",
  inState(async () => {
    const catalogKey = "agent:main:catalog-dependent";
    const metadataKey = "agent:main:independent-metadata";
    for (const sessionKey of [catalogKey, metadataKey]) {
      await seedEntry(sessionKey);
    }
    const entered = createDeferredCore();
    const replacement = markPreparedModelRuntimeSnapshotsStale("catalog reload", {
      waitForReplacement: true,
    });
    expect(replacement).toBeDefined();
    const loadGatewayModelCatalog = vi.fn(async () => {
      return await loadActualGatewayModelCatalog({
        agentId: "main",
        getConfig: () => ({}),
        loadPublishedPreparedModelCatalogOwnerSnapshot: (params) => {
          const pending = loadPublishedPreparedModelCatalogOwnerSnapshot(params);
          // The real owner captures the replacement gate synchronously before returning.
          entered.resolve();
          return pending;
        },
      });
    });
    const context = patchContext(loadGatewayModelCatalog);
    const catalogResponse = vi.fn();
    const metadataResponse = vi.fn();
    const successorResponse = vi.fn();
    const patch = patchRequest(context);
    const timing = diagnostics();
    const catalogTrace = createDiagnosticTraceContext();
    const successorTrace = createDiagnosticTraceContext();
    const catalogPatch = runWithDiagnosticTraceContext(catalogTrace, () =>
      patch({ key: catalogKey, contextWindow: "extended" }, catalogResponse),
    );
    let metadataPatch: ReturnType<typeof patch> | undefined;
    let successorPatch: ReturnType<typeof patch> | undefined;
    try {
      await Promise.race([entered.promise, catalogPatch]);
      expect(catalogResponse).not.toHaveBeenCalled();
      successorPatch = runWithDiagnosticTraceContext(successorTrace, () =>
        patch({ key: catalogKey, pinned: true }, successorResponse),
      );
      metadataPatch = patch({ key: metadataKey, pinned: true }, metadataResponse);
      // Join independent work before advancing the diagnostic clock or releasing the catalog.
      await metadataPatch;
      expectSuccess(metadataResponse);
      expect(catalogResponse).not.toHaveBeenCalled();
      expect(successorResponse).not.toHaveBeenCalled();
      expect(readEntry(catalogKey)?.pinnedAt).toBeUndefined();
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    } finally {
      timing.advance(1_500);
      rejectPendingPreparedModelRuntimeReplacement(
        replacement,
        new Error("Synthetic catalog reload failed"),
      );
      await Promise.allSettled([catalogPatch, metadataPatch, successorPatch]);
      timing.restore();
    }
    expectFailure(catalogResponse, unexpectedFailure);
    expect(readEntry(catalogKey)?.contextWindow).toBeUndefined();
    expectSuccess(successorResponse);
    expect(readEntry(catalogKey)?.pinnedAt).toEqual(expect.any(Number));
    expect(readEntry(metadataKey)?.pinnedAt).toEqual(expect.any(Number));
    expect(timing.records).toHaveLength(2);
    expect(
      timing.records.find((record) => record.traceId === catalogTrace.traceId)?.message,
    ).toMatch(
      /^slow session patch 1500ms method=sessions\.patch targets=1 fields=contextWindow .* catalog=1500ms(?: |$)/,
    );
    expect(
      timing.records.find((record) => record.traceId === successorTrace.traceId)?.message,
    ).toMatch(
      /^slow session patch 1500ms method=sessions\.patch targets=1 fields=pinned .* lifecycleAdmission=1500ms(?: |$)/,
    );
  }),
);

test.each(["identity", "label", "alias", "cleared-selection"] as const)(
  "catalog preparation revalidates fresh %s before using the prepared result",
  (change) =>
    inState(async () => {
      const key = change === "alias" ? "agent:main:main" : "agent:main:catalog-revalidation";
      const storedKey = change === "alias" ? "agent:main:work" : key;
      const otherKey = "agent:main:new-label-owner";
      const existing: SessionEntry = {
        sessionId: "before",
        updatedAt: 1,
        providerOverride: "anthropic",
        modelOverride: "claude-sonnet-4-6",
        ...(change === "cleared-selection"
          ? { thinkingLevel: "high", contextWindow: "extended" }
          : {}),
      };
      await seedEntry(storedKey, "main", existing);
      await seedEntry(otherKey, "main", { sessionId: "other" });
      const { entered, catalog, load } = pausedCatalog();
      const cfg: OpenClawConfig =
        change === "alias"
          ? { session: { mainKey: "work" }, agents: { entries: { main: {} } } }
          : {};
      const patch = patchRequest(patchContext(load, cfg));
      const response = vi.fn();
      const pending = patch(
        change === "cleared-selection"
          ? { key, model: null }
          : {
              key,
              expectedSessionId: "before",
              contextWindow: "extended",
              ...(change === "label" ? { label: "Claimed" } : {}),
            },
        response,
      );
      let mutation: Promise<unknown> | void = undefined;
      const changed = vi.fn();
      try {
        await Promise.race([entered.promise, pending]);
        expect(response).not.toHaveBeenCalled();
        mutation =
          change === "label"
            ? patch({ key: otherKey, label: "Claimed" }, changed)
            : upsertSessionEntryCore(
                { agentId: "main", sessionKey: key },
                change === "identity" || change === "alias"
                  ? { sessionId: "replacement", updatedAt: 2, label: "Replacement" }
                  : {
                      ...existing,
                      updatedAt: 2,
                      thinkingLevel: undefined,
                      contextWindow: undefined,
                    },
              );
        await mutation;
      } finally {
        if (change === "alias") {
          catalog.resolve([]);
        } else {
          catalog.reject(new Error("Synthetic catalog preparation failed"));
        }
        await Promise.allSettled([pending, mutation]);
      }
      expect(load).toHaveBeenCalledOnce();
      if (change === "cleared-selection") {
        expectSuccess(response);
        expectEntry(storedKey, { sessionId: "before" }, [
          "modelOverride",
          "providerOverride",
          "thinkingLevel",
          "contextWindow",
        ]);
      } else if (change === "identity") {
        expectFailure(
          response,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: { reason: "session-changed" },
          }),
        );
        expectEntry(storedKey, { sessionId: "replacement", label: "Replacement" }, [
          "contextWindow",
        ]);
      } else if (change === "alias") {
        expectFailure(response, unexpectedFailure);
        expectEntry(storedKey, { sessionId: "before" }, ["contextWindow"]);
        expectEntry(key, { sessionId: "replacement", label: "Replacement" }, ["contextWindow"]);
      } else {
        expectSuccess(changed);
        expectFailure(response, {
          code: "INVALID_REQUEST",
          message: "label already in use: Claimed",
        });
        expectEntry(storedKey, {}, ["label", "contextWindow"]);
        expect(readEntry(otherKey)?.label).toBe("Claimed");
      }
    })(),
);

test(
  "patchMany prepares singleton agent groups without blocking another session",
  inState(async () => {
    const targets = ["main", "secondary"].map((agentId) => ({
      key: `agent:${agentId}:catalog-batch`,
    }));
    for (const [index, { key }] of targets.entries()) {
      await seedEntry(key, index === 0 ? "main" : "secondary");
    }
    const metadataKey = "agent:main:batch-independent";
    await seedEntry(metadataKey);
    const { entered, catalog, load } = pausedCatalog(targets.length);
    const context = patchContext(load, {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        entries: { main: {}, secondary: {} },
      },
    });
    const respond = vi.fn();
    const timing = diagnostics();
    const batch = patchRequest(context, "sessions.patchMany")(
      { targets, patch: { contextWindow: "extended" } },
      respond,
    );
    const metadataResponse = vi.fn();
    let metadataPatch: Promise<void> | void = undefined;
    try {
      await Promise.race([entered.promise, batch]);
      metadataPatch = patchRequest(context)({ key: metadataKey, pinned: true }, metadataResponse);
      await metadataPatch;
      expectSuccess(metadataResponse);
      expect(respond).not.toHaveBeenCalled();
    } finally {
      timing.advance(1_500);
      catalog.resolve([
        {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          name: "Sonnet",
          contextWindows: [{ id: "extended", label: "Extended", contextWindow: 200_000 }],
        },
      ]);
      await Promise.allSettled([batch, metadataPatch]);
      timing.restore();
    }
    expect(load).toHaveBeenCalledTimes(2);
    expect(load).toHaveBeenCalledWith({ agentId: "main" });
    expect(load).toHaveBeenCalledWith({ agentId: "secondary" });
    expectSuccess(respond, { outcomes: targets.map(({ key }) => ({ key, ok: true })) });
    for (const [index, { key }] of targets.entries()) {
      expect(readEntry(key, index === 0 ? "main" : "secondary")?.contextWindow).toBe("extended");
    }
    expect(readEntry(metadataKey)?.pinnedAt).toEqual(expect.any(Number));
    expect(timing.records.map(({ message }) => message)).toEqual([
      expect.stringMatching(
        /^slow session patch 1500ms method=sessions\.patchMany targets=2 fields=contextWindow .* catalog=3000ms(?: |$)/,
      ),
    ]);
  }),
);

test(
  "a multi-target agent group retains ordered label claims around catalog loading",
  inState(async () => {
    const targets = ["first", "second"].map((name) => ({ key: `agent:main:ordered-${name}` }));
    for (const { key } of targets) {
      await seedEntry(key);
    }
    const loadGatewayModelCatalog = vi.fn(async () => []);
    const respond = vi.fn();
    await patchRequest(patchContext(loadGatewayModelCatalog), "sessions.patchMany")(
      { targets, patch: { label: "Winner", thinkingLevel: "low" } },
      respond,
    );
    expectSuccess(respond, {
      outcomes: [
        { key: targets[0]!.key, ok: true },
        {
          key: targets[1]!.key,
          ok: false,
          error: { code: "INVALID_REQUEST", message: "label already in use: Winner" },
        },
      ],
    });
    expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    expect(readEntry(targets[0]!.key)).toMatchObject({
      label: "Winner",
      thinkingLevel: "low",
    });
    const loser = readEntry(targets[1]!.key);
    expect([loser?.label, loser?.thinkingLevel]).toEqual([undefined, undefined]);
  }),
);

test(
  "dispatched authorization rejects an instance replaced during catalog preparation",
  inState(async () => {
    const member = await ensureCanonicalUserProfileForEmail("member@example.com");
    const sessionKey = "agent:main:commit-bound-authorization";
    // A write-scoped model reset revalidates the retained context window. Admin scope would
    // bypass the session-instance authorization this request must exercise.
    await seedEntry(sessionKey, "main", {
      sessionId: "session-shared",
      visibility: "shared",
      contextWindow: "extended",
    });
    const { entered, catalog, load } = pausedCatalog();
    const respond = vi.fn();
    const request = handleGatewayRequest({
      req: {
        type: "req",
        id: "catalog-authorization",
        method: "sessions.patch",
        params: { key: sessionKey, label: "stale mutation", model: null },
      },
      respond,
      client: {
        ...createSessionMutationTestClient(member.id),
        connId: "catalog-authorization",
        authenticatedUserId: "member@example.com",
      },
      isWebchatConnect: () => false,
      context: {
        ...patchContext(load),
        logGateway: { warn: vi.fn() },
        broadcast: vi.fn(),
      } as unknown as GatewayRequestContext,
      extraHandlers: { "sessions.patch": sessionMutationHandlers["sessions.patch"]! },
    });
    try {
      await Promise.race([entered.promise, request]);
      expect(respond).not.toHaveBeenCalled();
      await seedEntry(sessionKey, "main", {
        sessionId: "session-draft-replacement",
        updatedAt: 2,
        contextWindow: undefined,
        visibility: "draft",
        createdVia: "operator",
        createdActor: { type: "human", source: "profile", id: "owner" },
      });
      await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
        visibility: "draft",
      }));
      catalog.resolve([]);
      await request;
      expectFailure(
        respond,
        expect.objectContaining({
          details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
        }),
      );
      const current = readEntry(sessionKey);
      expect(current).toMatchObject({
        sessionId: "session-draft-replacement",
        visibility: "draft",
      });
      expect(current).not.toHaveProperty("label");
      expect(current).not.toHaveProperty("contextWindow");
    } finally {
      catalog.resolve([]);
      await Promise.allSettled([request]);
    }
  }),
);

test(
  "patch timing covers preparation and lifecycle finalization before cleanup",
  inState(async () => {
    const key = "agent:main:phase-boundaries";
    await seedEntry(key, "main", { sessionId: "phase-boundaries" });
    const timing = diagnostics();
    const runMutation = sessionLifecycle.runSessionMutation;
    const lifecycle = vi
      .spyOn(sessionLifecycle, "runSessionMutation")
      .mockImplementation((params) =>
        runMutation({
          ...params,
          prepare: async (owner) => {
            await params.prepare?.(owner);
            timing.advance(700);
          },
          finalize: async () => {
            await params.finalize?.();
            timing.advance(500);
          },
        }),
      );
    const response = vi.fn();
    try {
      await patchRequest(patchContext(async () => []))({ key, pinned: true }, response);
      expectSuccess(response);
      const message = timing.records.find((record) =>
        record.message.startsWith("slow session patch 1200ms method=sessions.patch "),
      )?.message;
      for (const phase of [
        "lifecycleAdmission=700ms",
        "lifecycleFinalize=500ms",
        "cleanup=0ms",
        "snapshot=0ms",
        "commit=0ms",
      ]) {
        expect(message).toContain(` ${phase}`);
      }
    } finally {
      lifecycle.mockRestore();
      timing.restore();
    }
  }),
);

test(
  "patchMany creates one shared physical store through original per-agent directory aliases",
  inState(async (state) => {
    const directory = state.statePath("patch-many-alias-birth");
    const physical = path.join(directory, "physical");
    const aliases = path.join(directory, "links");
    await fs.mkdir(physical, { recursive: true });
    await fs.mkdir(aliases);
    const targets = ["main", "work"].map((agentId) => ({
      agentId,
      key: `agent:${agentId}:dashboard:shared-alias-birth`,
    }));
    for (const { agentId } of targets) {
      await fs.symlink(
        physical,
        path.join(aliases, agentId),
        process.platform === "win32" ? "junction" : "dir",
      );
    }
    const physicalFile = path.join(await fs.realpath(physical), "shared.sqlite");
    const storeFor = (agentId: string) => path.join(aliases, agentId, "shared.sqlite");
    const context = await modelContext(state, path.join(aliases, "{agentId}", "shared.sqlite"));
    const response = vi.fn();
    const params = { targets, patch: { model: "openai/gpt-5.6-sol" } };
    await expect(fs.stat(physicalFile)).rejects.toMatchObject({ code: "ENOENT" });
    // The existing direct method harness uses null only for a trusted internal caller.
    const batch = patchRequest(context, "sessions.patchMany");
    await batch(params, response);
    const outcomes = targets.map((target) => ({ ...target, ok: true }));
    expectBatch(response, outcomes);
    const instances = targets.map(({ agentId, key }) => {
      const entry = readEntry(key, agentId, storeFor(agentId));
      expect(entry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        sessionId: expect.any(String),
      });
      if (!entry) {
        throw new Error("Successful alias patch did not persist its session");
      }
      return { agentId, key, expectedSessionId: entry.sessionId };
    });
    for (const { agentId } of instances) {
      expect(await fs.realpath(storeFor(agentId))).toBe(physicalFile);
    }
    const currentResponse = vi.fn();
    const currentParams = {
      targets: instances,
      patch: { model: "openai/gpt-5.6-sol", pinned: true },
    };
    await batch(currentParams, currentResponse);
    expectBatch(currentResponse, outcomes);
    for (const { agentId, key, expectedSessionId } of instances) {
      expect(readEntry(key, agentId, storeFor(agentId))).toMatchObject({
        sessionId: expectedSessionId,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        pinnedAt: expect.any(Number),
      });
    }
  }, false),
);

test(
  "patchMany excludes a revoked cold-store promotion while its independent store commits",
  inState(async (state) => {
    const fixtureDirectory = state.statePath("independent-cold-patch");
    await fs.mkdir(fixtureDirectory, { recursive: true });
    const directory = await fs.realpath(fixtureDirectory);
    const targets = ["main", "work"].map((agentId) => ({
      agentId,
      key: `agent:${agentId}:dashboard:cold-promotion`,
    }));
    const failed = targets[0]!;
    const successful = targets[1]!;
    const failedPath = path.join(directory, failed.agentId, "store.sqlite");
    const successfulPath = path.join(directory, successful.agentId, "store.sqlite");
    const context = await modelContext(state, path.join(directory, "{agentId}", "store.sqlite"));
    const revoked = new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.FORBIDDEN, "Original cold-store source was revoked"),
    );
    const source = new AbortController();
    const admissionObserver = probe.admission(workerAdmission, (request, grant, admit) => {
      if (
        request.stage === "open" &&
        isRecord(request.facts) &&
        request.facts.databasePath === failedPath &&
        isRecord(request.facts.creatingIdentity) &&
        request.facts.creatingIdentity.key === `path:${failedPath}`
      ) {
        source.abort(revoked);
      }
      admit(request, grant);
    });
    const respond = vi.fn();
    const params = { targets, patch: { model: "openai/gpt-5.6-sol" } };
    try {
      await expect(fs.stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(successfulPath)).rejects.toMatchObject({ code: "ENOENT" });
      await patchRequest(context, "sessions.patchMany")(params, respond, {
        assertCurrent() {},
        assertTargetCurrent({ sessionKey }) {
          if (sessionKey === failed.key) {
            source.signal.throwIfAborted();
          }
        },
      });
      expectBatch(respond, [
        { ...failed, ok: false, error: revoked.error },
        { ...successful, ok: true },
      ]);
      await expect(fs.stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(readEntry(successful.key, successful.agentId, successfulPath)).toMatchObject({
        sessionId: expect.any(String),
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
    } finally {
      admissionObserver.mockRestore();
    }
  }, false),
);
