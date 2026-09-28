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
import { validateConfigObject, type OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions.js";
import {
  loadSessionEntry,
  patchSessionEntryCore,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import * as sessionReplacement from "../../config/sessions/session-accessor.sqlite-replacement-projection.js";
import {
  areDiagnosticsEnabledForProcess,
  setDiagnosticsEnabledForProcess,
} from "../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import * as sessionLifecycle from "../../sessions/session-lifecycle-admission.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { getOpenIncognitoAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import {
  closeOpenClawAgentDatabasesForTest,
  resolveIncognitoOpenClawAgentSqlitePath,
} from "../../state/openclaw-agent-db.js";
import { ensureCanonicalUserProfileForEmail } from "../../state/user-profile-writes.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { handleGatewayRequest } from "../server-methods.js";
import { loadGatewayModelCatalog as loadActualGatewayModelCatalog } from "../server-model-catalog.js";
import { SessionMutationAuthorizationChangedError } from "../session-mutation-authorization-error.js";
import { sessionMutationHandlers } from "./sessions-mutations.js";
import { sessionLog } from "./sessions-shared.js";
import type { GatewayRequestContext } from "./types.js";

afterEach(async () => {
  await resetPreparedModelRuntimeSnapshotsForTest();
  closeOpenClawAgentDatabasesForTest();
});

function patchContext(
  loadGatewayModelCatalog: GatewayRequestContext["loadGatewayModelCatalog"],
  cfg: OpenClawConfig = {},
) {
  return {
    getRuntimeConfig: () => cfg,
    loadGatewayModelCatalogSnapshot: async (
      params: Parameters<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>[0],
    ) => {
      const entries = await loadGatewayModelCatalog(params);
      return { entries, routeVariants: entries };
    },
    getSessionEventSubscriberConnIds: () => new Set(),
    broadcastToConnIds: vi.fn(),
    chatAbortControllers: new Map(),
    chatQueuedTurns: new Map(),
    dedupe: new Map(),
  } as unknown as GatewayRequestContext;
}

function patchRequest(context: GatewayRequestContext) {
  return (params: Record<string, unknown>, respond: ReturnType<typeof vi.fn>) =>
    sessionMutationHandlers["sessions.patch"]!({
      params,
      respond,
      context,
      client: null,
    } as never);
}

test("catalog reload releases the agent writer while preserving same-session ordering", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const catalogKey = "agent:main:catalog-dependent";
    const metadataKey = "agent:main:independent-metadata";
    for (const sessionKey of [catalogKey, metadataKey]) {
      await upsertSessionEntryCore(
        { agentId: "main", env: state.env, sessionKey },
        { sessionId: sessionKey, updatedAt: 1 },
      );
    }
    await import("../../agents/prepared-model-catalog.js");
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
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    let clock = performance.now();
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const catalogTrace = createDiagnosticTraceContext();
    const successorTrace = createDiagnosticTraceContext();
    const records: Array<{ traceId: string | undefined; metadata: unknown }> = [];
    const logSpy = vi.spyOn(sessionLog, "info").mockImplementation((message, metadata) => {
      if (message === "slow session patch") {
        records.push({ traceId: getActiveDiagnosticTraceContext()?.traceId, metadata });
      }
    });
    const catalogPatch = runWithDiagnosticTraceContext(catalogTrace, () =>
      patch({ key: catalogKey, contextWindow: "extended" }, catalogResponse),
    );
    let metadataPatch: ReturnType<typeof patch> | undefined;
    let successorPatch: ReturnType<typeof patch> | undefined;
    try {
      await Promise.race([entered.promise, catalogPatch]);
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      expect(catalogResponse).not.toHaveBeenCalled();
      successorPatch = runWithDiagnosticTraceContext(successorTrace, () =>
        patch({ key: catalogKey, pinned: true }, successorResponse),
      );
      metadataPatch = patch({ key: metadataKey, pinned: true }, metadataResponse);
      // Join independent work before advancing the diagnostic clock or releasing the catalog.
      await metadataPatch;
      expect(metadataResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      expect(catalogResponse).not.toHaveBeenCalled();
      expect(successorResponse).not.toHaveBeenCalled();
      expect(
        loadSessionEntry({ agentId: "main", sessionKey: catalogKey })?.pinnedAt,
      ).toBeUndefined();
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    } finally {
      clock += 1_500;
      rejectPendingPreparedModelRuntimeReplacement(
        replacement,
        new Error("Synthetic catalog reload failed"),
      );
      await Promise.allSettled([catalogPatch, metadataPatch, successorPatch]);
      clockSpy.mockRestore();
      logSpy.mockRestore();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
    expect(catalogResponse).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Session patch failed unexpectedly. Retry the request.",
      retryable: true,
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: catalogKey })?.contextWindow,
    ).toBeUndefined();
    expect(metadataResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(successorResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined);
    expect(loadSessionEntry({ agentId: "main", sessionKey: catalogKey })?.pinnedAt).toEqual(
      expect.any(Number),
    );
    expect(loadSessionEntry({ agentId: "main", sessionKey: metadataKey })?.pinnedAt).toEqual(
      expect.any(Number),
    );
    expect(records).toHaveLength(2);
    expect(records.find((record) => record.traceId === catalogTrace.traceId)?.metadata).toEqual(
      expect.objectContaining({
        method: "sessions.patch",
        phaseDurationsMs: expect.objectContaining({ catalog: 1_500 }),
        phaseCounts: expect.objectContaining({ catalog: 1 }),
      }),
    );
    expect(records.find((record) => record.traceId === successorTrace.traceId)?.metadata).toEqual(
      expect.objectContaining({
        method: "sessions.patch",
        phaseDurationsMs: expect.objectContaining({ lifecycleAdmission: 1_500 }),
      }),
    );
  });
});

test.each(["identity", "label", "alias", "cleared-selection"] as const)(
  "catalog preparation revalidates fresh %s before using the prepared result",
  async (change) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
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
      await upsertSessionEntryCore({ agentId: "main", sessionKey: storedKey }, existing);
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: otherKey },
        { sessionId: "other", updatedAt: 1 },
      );
      const entered = createDeferredCore();
      const catalog =
        createDeferredCore<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
      const loadGatewayModelCatalog = vi.fn(() => {
        entered.resolve();
        return catalog.promise;
      });
      const patch = patchRequest(
        patchContext(
          loadGatewayModelCatalog,
          change === "alias"
            ? {
                session: { mainKey: "work" },
                agents: { list: [{ id: "main", default: true }] },
              }
            : {},
        ),
      );
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
        expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
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
              ).then(() => changed());
        await mutation;
        expect(changed).toHaveBeenCalledOnce();
      } finally {
        if (change === "alias") {
          catalog.resolve([]);
        } else {
          catalog.reject(new Error("Synthetic catalog preparation failed"));
        }
        await Promise.allSettled([pending, mutation]);
      }
      expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
      const stored = loadSessionEntry({ agentId: "main", sessionKey: storedKey });
      if (change === "cleared-selection") {
        expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(stored).toMatchObject({ sessionId: "before" });
        expect(stored?.modelOverride).toBeUndefined();
        expect(stored?.providerOverride).toBeUndefined();
        expect(stored?.thinkingLevel).toBeUndefined();
        expect(stored?.contextWindow).toBeUndefined();
      } else if (change === "identity") {
        expect(response).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({
            code: "INVALID_REQUEST",
            details: { reason: "session-changed" },
          }),
        );
        expect(stored).toMatchObject({ sessionId: "replacement", label: "Replacement" });
        expect(stored?.contextWindow).toBeUndefined();
      } else if (change === "alias") {
        expect(response).toHaveBeenCalledWith(false, undefined, {
          code: "UNAVAILABLE",
          message: "Session patch failed unexpectedly. Retry the request.",
          retryable: true,
        });
        expect(stored).toMatchObject({ sessionId: "before" });
        expect(stored?.contextWindow).toBeUndefined();
        expect(loadSessionEntry({ agentId: "main", sessionKey: key })).toMatchObject({
          sessionId: "replacement",
          label: "Replacement",
        });
        expect(
          loadSessionEntry({ agentId: "main", sessionKey: key })?.contextWindow,
        ).toBeUndefined();
      } else {
        expect(changed).toHaveBeenCalledWith(true, expect.any(Object), undefined);
        expect(response).toHaveBeenCalledWith(false, undefined, {
          code: "INVALID_REQUEST",
          message: "label already in use: Claimed",
        });
        expect(stored?.label).toBeUndefined();
        expect(stored?.contextWindow).toBeUndefined();
        expect(loadSessionEntry({ agentId: "main", sessionKey: otherKey })?.label).toBe("Claimed");
      }
    });
  },
);

test("patchMany prepares singleton agent groups without blocking another session", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const targets = ["main", "secondary"].map((agentId) => ({
      key: `agent:${agentId}:catalog-batch`,
    }));
    for (const [index, { key }] of targets.entries()) {
      await upsertSessionEntryCore(
        { agentId: index === 0 ? "main" : "secondary", sessionKey: key },
        { sessionId: key, updatedAt: 1 },
      );
    }
    const metadataKey = "agent:main:batch-independent";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: metadataKey },
      { sessionId: metadataKey, updatedAt: 1 },
    );
    const catalog =
      createDeferredCore<Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalog"]>>>();
    const entered = createDeferredCore();
    const loadGatewayModelCatalog = vi.fn(() => {
      if (loadGatewayModelCatalog.mock.calls.length === targets.length) {
        entered.resolve();
      }
      return catalog.promise;
    });
    const context = patchContext(loadGatewayModelCatalog, {
      agents: {
        defaults: { model: "anthropic/claude-sonnet-4-6" },
        list: [{ id: "main" }, { id: "secondary" }],
      },
    });
    const respond = vi.fn();
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    let clock = performance.now();
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const timingRecords: unknown[] = [];
    const logSpy = vi.spyOn(sessionLog, "info").mockImplementation((message, metadata) => {
      if (message === "slow session patch") {
        timingRecords.push(metadata);
      }
    });
    const batch = sessionMutationHandlers["sessions.patchMany"]!({
      params: { targets, patch: { contextWindow: "extended" } },
      respond,
      context,
      client: null,
    } as never);
    const metadataResponse = vi.fn();
    let metadataPatch: Promise<void> | void = undefined;
    try {
      await Promise.race([entered.promise, batch]);
      expect(loadGatewayModelCatalog).toHaveBeenCalledTimes(2);
      metadataPatch = patchRequest(context)({ key: metadataKey, pinned: true }, metadataResponse);
      await metadataPatch;
      expect(metadataResponse).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      expect(respond).not.toHaveBeenCalled();
    } finally {
      clock += 1_500;
      catalog.resolve([
        {
          provider: "anthropic",
          id: "claude-sonnet-4-6",
          name: "Sonnet",
          contextWindows: [{ id: "extended", label: "Extended", contextWindow: 200_000 }],
        },
      ]);
      await Promise.allSettled([batch, metadataPatch]);
      clockSpy.mockRestore();
      logSpy.mockRestore();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
    expect(loadGatewayModelCatalog).toHaveBeenCalledTimes(2);
    expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "main" });
    expect(loadGatewayModelCatalog).toHaveBeenCalledWith({ agentId: "secondary" });
    expect(respond).toHaveBeenCalledWith(
      true,
      { outcomes: targets.map(({ key }) => ({ key, ok: true })) },
      undefined,
    );
    for (const [index, { key }] of targets.entries()) {
      expect(
        loadSessionEntry({ agentId: index === 0 ? "main" : "secondary", sessionKey: key })
          ?.contextWindow,
      ).toBe("extended");
    }
    expect(loadSessionEntry({ agentId: "main", sessionKey: metadataKey })?.pinnedAt).toEqual(
      expect.any(Number),
    );
    expect(timingRecords).toEqual([
      expect.objectContaining({
        method: "sessions.patchMany",
        elapsedMs: 1_500,
        phaseDurationsMs: expect.objectContaining({ catalog: 3_000 }),
        phaseCounts: expect.objectContaining({ catalog: 2 }),
      }),
    ]);
  });
});

test("a multi-target agent group retains ordered label claims around catalog loading", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const targets = ["first", "second"].map((name) => ({ key: `agent:main:ordered-${name}` }));
    for (const { key } of targets) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key },
        { sessionId: key, updatedAt: 1 },
      );
    }
    const loadGatewayModelCatalog = vi.fn(async () => []);
    const respond = vi.fn();
    await sessionMutationHandlers["sessions.patchMany"]!({
      params: { targets, patch: { label: "Winner", thinkingLevel: "low" } },
      respond,
      context: patchContext(loadGatewayModelCatalog),
      client: null,
    } as never);
    expect(respond).toHaveBeenCalledWith(
      true,
      {
        outcomes: [
          { key: targets[0]!.key, ok: true },
          {
            key: targets[1]!.key,
            ok: false,
            error: { code: "INVALID_REQUEST", message: "label already in use: Winner" },
          },
        ],
      },
      undefined,
    );
    expect(loadGatewayModelCatalog).toHaveBeenCalledOnce();
    expect(loadSessionEntry({ agentId: "main", sessionKey: targets[0]!.key })).toMatchObject({
      label: "Winner",
      thinkingLevel: "low",
    });
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: targets[1]!.key })?.label,
    ).toBeUndefined();
    expect(
      loadSessionEntry({ agentId: "main", sessionKey: targets[1]!.key })?.thinkingLevel,
    ).toBeUndefined();
  });
});

test("dispatched authorization rejects an instance replaced during catalog preparation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const member = await ensureCanonicalUserProfileForEmail("member@example.com");
    const sessionKey = "agent:main:commit-bound-authorization";
    // A write-scoped model reset revalidates retained thinking. Admin scope would
    // bypass the session-instance authorization this request must exercise.
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "session-shared", updatedAt: 1, visibility: "shared", thinkingLevel: "off" },
    );
    const entered = createDeferredCore();
    const release = createDeferredCore();
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
        connId: "catalog-authorization",
        authenticatedUserId: "member@example.com",
        authenticatedUserProfile: {
          profileId: member.id,
          displayName: "Member",
          hasAvatar: false,
          updatedAt: 1,
        },
        connect: {
          role: "operator",
          scopes: ["operator.write"],
          client: { id: "test", version: "1", platform: "test", mode: "test" },
          minProtocol: 1,
          maxProtocol: 1,
        },
      } as Parameters<typeof handleGatewayRequest>[0]["client"],
      isWebchatConnect: () => false,
      context: {
        ...patchContext(async () => {
          entered.resolve();
          await release.promise;
          return [];
        }),
        logGateway: { warn: vi.fn() },
        broadcast: vi.fn(),
      } as unknown as GatewayRequestContext,
      extraHandlers: { "sessions.patch": sessionMutationHandlers["sessions.patch"]! },
    });
    let replacement: Promise<void> | undefined;
    const committed = vi.fn();
    try {
      await Promise.race([entered.promise, request]);
      expect(respond).not.toHaveBeenCalled();
      replacement = (async () => {
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "session-draft-replacement",
            updatedAt: 2,
            thinkingLevel: undefined,
            visibility: "draft",
            createdVia: "operator",
            createdActor: { type: "human", source: "profile", id: "owner" },
          },
        );
        await patchSessionEntryCore({ agentId: "main", sessionKey }, () => ({
          visibility: "draft",
        }));
        committed();
      })();
      void replacement.catch(() => {});
      await replacement;
      expect(committed).toHaveBeenCalledOnce();
      release.resolve();
      await request;
      expect(respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({
          details: expect.objectContaining({ code: "SESSION_MUTATION_AUTHORIZATION_CHANGED" }),
        }),
      );
      const current = loadSessionEntry({ agentId: "main", sessionKey });
      expect(current).toMatchObject({
        sessionId: "session-draft-replacement",
        visibility: "draft",
      });
      expect(current).not.toHaveProperty("label");
      expect(current).not.toHaveProperty("thinkingLevel");
    } finally {
      release.resolve();
      await Promise.allSettled([request, replacement]);
    }
  });
});

test("patch timing covers preparation and lifecycle finalization before cleanup", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const key = "agent:main:phase-boundaries";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: key },
      { sessionId: "phase-boundaries", updatedAt: 1 },
    );
    const previousDiagnostics = areDiagnosticsEnabledForProcess();
    setDiagnosticsEnabledForProcess(true);
    let clock = performance.now();
    const clockSpy = vi.spyOn(performance, "now").mockImplementation(() => clock);
    const log = vi.spyOn(sessionLog, "info").mockImplementation(() => {});
    const runMutation = sessionLifecycle.runExclusiveSessionLifecycleMutation;
    const lifecycle = vi
      .spyOn(sessionLifecycle, "runExclusiveSessionLifecycleMutation")
      .mockImplementation((params) =>
        runMutation({
          ...params,
          prepare: async (owner) => {
            await params.prepare?.(owner);
            clock += 700;
          },
          finalize: async () => {
            await params.finalize?.();
            clock += 500;
          },
        }),
      );
    const response = vi.fn();
    try {
      await patchRequest(patchContext(async () => []))({ key, pinned: true }, response);
      expect(response).toHaveBeenCalledWith(true, expect.any(Object), undefined);
      expect(log).toHaveBeenCalledWith(
        "slow session patch",
        expect.objectContaining({
          elapsedMs: 1_200,
          phaseDurationsMs: expect.objectContaining({
            lifecycleAdmission: 700,
            lifecycleFinalize: 500,
            cleanup: 0,
            snapshot: 0,
            commit: 0,
          }),
        }),
      );
    } finally {
      lifecycle.mockRestore();
      log.mockRestore();
      clockSpy.mockRestore();
      setDiagnosticsEnabledForProcess(previousDiagnostics);
    }
  });
});

test("patchMany creates one shared physical store through original per-agent directory aliases", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
            models: [model].map(({ provider: _provider, ...definition }) => definition),
          },
        },
      },
      agents: {
        defaults: { model: "openai/gpt-5.6-sol" },
        ownership: "explicit",
        entries: { main: {}, work: {} },
      },
      session: { store: path.join(aliases, "{agentId}", "shared.sqlite") },
    };
    expect(validateConfigObject(cfg)).toMatchObject({ ok: true });
    await state.writeConfig(cfg);
    const context = patchContext(async () => [model], cfg);
    const response = vi.fn();
    const params = { targets, patch: { model: "openai/gpt-5.6-sol" } };
    await expect(fs.stat(physicalFile)).rejects.toMatchObject({ code: "ENOENT" });
    // The existing direct method harness uses null only for a trusted internal caller.
    await sessionMutationHandlers["sessions.patchMany"]!({
      req: { type: "req", id: "shared-alias-birth", method: "sessions.patchMany", params },
      params,
      respond: response,
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(response).toHaveBeenCalledExactlyOnceWith(
      true,
      { outcomes: targets.map(({ agentId, key }) => ({ agentId, key, ok: true })) },
      undefined,
    );
    const instances = targets.map(({ agentId, key }) => {
      const storePath = path.join(aliases, agentId, "shared.sqlite");
      const entry = loadSessionEntry({ agentId, sessionKey: key, storePath });
      expect(entry).toMatchObject({
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        sessionId: expect.any(String),
      });
      if (!entry) {
        throw new Error("Successful alias patch did not persist its session");
      }
      return { agentId, key, storePath, expectedSessionId: entry.sessionId };
    });
    for (const { storePath } of instances) {
      expect(await fs.realpath(storePath)).toBe(physicalFile);
    }
    const currentResponse = vi.fn();
    const currentParams = {
      targets: instances.map(({ agentId, key, expectedSessionId }) => ({
        agentId,
        key,
        expectedSessionId,
      })),
      patch: { model: "openai/gpt-5.6-sol", pinned: true },
    };
    await sessionMutationHandlers["sessions.patchMany"]!({
      req: {
        type: "req",
        id: "shared-alias-current",
        method: "sessions.patchMany",
        params: currentParams,
      },
      params: currentParams,
      respond: currentResponse,
      context,
      client: null,
      isWebchatConnect: () => false,
    });
    expect(currentResponse).toHaveBeenCalledExactlyOnceWith(
      true,
      { outcomes: targets.map(({ agentId, key }) => ({ agentId, key, ok: true })) },
      undefined,
    );
    for (const { agentId, key, storePath, expectedSessionId } of instances) {
      expect(loadSessionEntry({ agentId, sessionKey: key, storePath })).toMatchObject({
        sessionId: expectedSessionId,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
        pinnedAt: expect.any(Number),
      });
    }
  });
});

test("patchMany retains original RAM facts while its cold durable sibling publishes registration", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const storePath = state.statePath("mixed-patch-cold.sqlite");
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
            models: [model].map(({ provider: _provider, ...definition }) => definition),
          },
        },
      },
      agents: {
        defaults: { model: "openai/gpt-5.6-sol" },
        entries: { main: {} },
      },
      session: { store: storePath },
    };
    expect(validateConfigObject(cfg)).toMatchObject({ ok: true });
    await state.writeConfig(cfg);
    const ramKey = "agent:main:dashboard:incognito-mixed-patch";
    const ramPath = resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env });
    const ramScope = { agentId: "main", sessionKey: ramKey, storePath: ramPath };
    const ramIdentity = {
      sessionId: "original-mixed-ram",
      lifecycleRevision: "original-mixed-ram-generation",
      incognito: true as const,
    };
    await upsertSessionEntryCore(ramScope, { ...ramIdentity, updatedAt: 1 });
    const originalRam = getOpenIncognitoAgentDatabase("main", ramPath);
    if (!originalRam) {
      throw new Error("Incognito fixture did not retain its original RAM database");
    }
    const fileKey = "agent:main:dashboard:mixed-file-patch";
    const targets = [
      { agentId: "main", key: ramKey, expectedSessionId: ramIdentity.sessionId },
      { agentId: "main", key: fileKey },
    ];
    const params = { targets, patch: { model: "openai/gpt-5.6-sol" } };
    const context = patchContext(async () => [model], cfg);
    const response = vi.fn();
    const ramLifetimesAtStoresPublication: boolean[] = [];
    const stop = sessionChanges.subscribe((change) => {
      if ("all" in change && change.scope === "stores") {
        ramLifetimesAtStoresPublication.push(
          getOpenIncognitoAgentDatabase("main", ramPath) === originalRam && originalRam.db.isOpen,
        );
      }
    });
    try {
      await expect(fs.stat(storePath)).rejects.toMatchObject({ code: "ENOENT" });
      await sessionMutationHandlers["sessions.patchMany"]!({
        req: { type: "req", id: "mixed-file-ram-patch", method: "sessions.patchMany", params },
        params,
        respond: response,
        context,
        client: null,
        isWebchatConnect: () => false,
      });
      expect(ramLifetimesAtStoresPublication.length).toBeGreaterThan(0);
      expect(ramLifetimesAtStoresPublication.every(Boolean)).toBe(true);
      expect(response).toHaveBeenCalledExactlyOnceWith(
        true,
        { outcomes: targets.map(({ agentId, key }) => ({ agentId, key, ok: true })) },
        undefined,
      );
      expect(getOpenIncognitoAgentDatabase("main", ramPath)).toBe(originalRam);
      expect(originalRam.db.isOpen).toBe(true);
      expect(loadSessionEntry(ramScope)).toMatchObject({
        ...ramIdentity,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      expect(loadSessionEntry({ agentId: "main", sessionKey: fileKey, storePath })).toMatchObject({
        sessionId: expect.any(String),
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      await expect(fs.stat(ramPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      stop();
    }
  });
});

test("patchMany excludes a revoked cold-store promotion while its independent store commits", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
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
            models: [model].map(({ provider: _provider, ...definition }) => definition),
          },
        },
      },
      agents: {
        defaults: { model: "openai/gpt-5.6-sol" },
        ownership: "explicit",
        entries: { main: {}, work: {} },
      },
      session: { store: path.join(directory, "{agentId}", "store.sqlite") },
    };
    expect(validateConfigObject(cfg)).toMatchObject({ ok: true });
    await state.writeConfig(cfg);
    const context = patchContext(async () => [model], cfg);
    const revoked = new SessionMutationAuthorizationChangedError(
      errorShape(ErrorCodes.FORBIDDEN, "Original cold-store source was revoked"),
    );
    const source = new AbortController();
    const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
    let failedOpenAdmissions = 0;
    const admissionObserver = vi
      .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
      .mockImplementation((admit, attachment) =>
        createAdmission((request, grant) => {
          if (
            request.stage === "open" &&
            isRecord(request.facts) &&
            request.facts.databasePath === failedPath &&
            isRecord(request.facts.creatingIdentity) &&
            request.facts.creatingIdentity.key === `path:${failedPath}`
          ) {
            failedOpenAdmissions++;
            source.abort(revoked);
          }
          admit(request, grant);
        }, attachment),
      );
    const writers = vi.spyOn(sessionReplacement, "applySessionEntryCanonicalReplacements");
    const respond = vi.fn();
    const params = { targets, patch: { model: "openai/gpt-5.6-sol" } };
    try {
      await expect(fs.stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.stat(successfulPath)).rejects.toMatchObject({ code: "ENOENT" });
      await sessionMutationHandlers["sessions.patchMany"]!({
        req: {
          type: "req",
          id: "independent-cold-promotion",
          method: "sessions.patchMany",
          params,
        },
        params,
        respond,
        context,
        client: null,
        isWebchatConnect: () => false,
        sessionMutationAuthorization: {
          assertCurrent() {},
          assertTargetCurrent({ sessionKey }) {
            if (sessionKey === failed.key) {
              source.signal.throwIfAborted();
            }
          },
        },
      });
      expect(failedOpenAdmissions).toBe(1);
      expect(source.signal.reason).toBe(revoked);
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        true,
        {
          outcomes: [
            { ...failed, ok: false, error: revoked.error },
            { ...successful, ok: true },
          ],
        },
        undefined,
      );
      // Failed preparation must not reenter the canonical writer through a fallback.
      expect(writers.mock.calls.some(([request]) => request.storePath === failedPath)).toBe(false);
      expect(writers.mock.calls.some(([request]) => request.storePath === successfulPath)).toBe(
        true,
      );
      await expect(fs.stat(failedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(
        loadSessionEntry({
          agentId: successful.agentId,
          sessionKey: successful.key,
          storePath: successfulPath,
        }),
      ).toMatchObject({
        sessionId: expect.any(String),
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
    } finally {
      writers.mockRestore();
      admissionObserver.mockRestore();
    }
  });
});
