import { AsyncLocalStorage } from "node:async_hooks";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import * as sqliteTarget from "../config/sessions/session-sqlite-target.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runInDetachedAsyncContext } from "../shared/detached-async-context.js";
import {
  assertAgentDatabaseAdmitted,
  readAgentDatabaseAdmissionRefusal,
  recordAgentDatabaseAdmissions,
} from "../state/agent-database-admission.js";
import {
  getAgentDatabaseStartupAdmission,
  withAgentDatabaseStartupAdmission,
} from "../state/agent-database-startup.js";
import * as deletionJournal from "../state/agent-deletion-journal.read.js";
import { createRequestGatewayMethodRegistry, handleGatewayRequest } from "./server-methods.js";
import { authorizeGatewayRequestPreDispatch } from "./server-methods/request-authorization.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import type { GatewayRequestHandler } from "./server-methods/types.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import { readPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowAncestorReads } from "./session-row-projection-ancestors.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const cfg = { agents: { entries: { main: {} } } };
const query = { agentId: "main", key: "agent:main:dashboard:incognito-prepared" };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function describeFixture() {
  const projection = createSessionRowProjectionFixture({ cfg, store: {} });
  projection.withPreparedExactRows = async (queries, consume) =>
    readPreparedSessionRows(projection, () => true, queries, consume);
  const context = bindSessionRowProjection(requestContext(cfg), () => projection);
  const client = sharingPolicyClient({ scopes: ["operator.admin"] });
  const request = {
    method: "sessions.describe",
    requestParams: { key: query.key },
    client,
    context,
    methodRegistry: createRequestGatewayMethodRegistry(),
  };
  const dispatch = (
    req: Parameters<typeof handleGatewayRequest>[0]["req"],
    respond: Parameters<typeof handleGatewayRequest>[0]["respond"],
    extraHandlers = sessionByKeyReadHandlers,
  ) =>
    handleGatewayRequest({
      req,
      context,
      client,
      respond,
      isWebchatConnect: () => false,
      extraHandlers,
    });
  return { projection, context, client, request, dispatch };
}

async function withPendingStartupInspection(
  run: (
    fixture: ReturnType<typeof describeFixture> & {
      complete: () => void;
      fail: (error: Error) => void;
      databasePath: string;
      admission: Parameters<Parameters<typeof withAgentDatabaseStartupAdmission>[0]>[0];
    },
  ) => Promise<void>,
) {
  vi.useFakeTimers();
  const root = tempDirs.make("request-startup-inspection-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const pathname = path.join(root, "agent.sqlite");
  writeFileSync(pathname, "synthetic identity; native preparation is separate proof");
  vi.spyOn(deletionJournal, "readAgentDeletionJournalStatusInWorker").mockResolvedValue("absent");
  const inspection = createDeferredCore<{ incompatible: []; indeterminate: [] }>();
  const complete = () => inspection.resolve({ incompatible: [], indeterminate: [] });
  const fixture = describeFixture();
  await withAgentDatabaseStartupAdmission(async (admission) => {
    recordAgentDatabaseAdmissions(
      admission.defer({
        env: process.env,
        inspections: [{ target: { agentId: "main", path: pathname }, result: inspection.promise }],
        reason: "synthetic inspection in progress",
      }),
      { source: "startup" },
    );
    const owner = admission.adopt();
    admission.activate({
      isCurrent: () => true,
      preparationReady: Promise.resolve(),
      openAgent: async () => {},
      migrateAgent: async () => {},
      publishAgent: async () => {},
    });
    fixture.context.agentDatabaseStartup = {
      get hasPendingAgents() {
        return admission.hasPendingAgents;
      },
      waitForAgentPreparation: admission.waitForAgentPreparation.bind(admission),
    };
    try {
      await runInDetachedAsyncContext(() => {
        expect(getAgentDatabaseStartupAdmission()).toBeUndefined();
        return run({
          ...fixture,
          complete,
          fail: inspection.reject,
          admission,
          databasePath: pathname,
        });
      });
    } finally {
      complete();
      await admission.pendingPreparation;
      await owner.stop();
      recordAgentDatabaseAdmissions([], { source: "startup" });
      fixture.projection.dispose();
    }
  });
}

function useSharedStore(context: ReturnType<typeof requestContext>, databasePath: string) {
  const sharedConfig: OpenClawConfig = {
    agents: {
      ownership: "explicit",
      entries: { main: {}, ops: {} },
      defaults: { sessionStore: { agentId: "ops" } },
    },
    session: { scope: "global", store: databasePath },
  };
  context.getRuntimeConfig = () => sharedConfig;
  // Native routing and host-SQL isolation are covered by session-sqlite-target.worker.test.ts.
  vi.spyOn(sqliteTarget, "prepareSqliteTargetFromSessionStorePath").mockResolvedValue({
    agentId: "main",
    path: databasePath,
    shared: true,
  });
}

it("refuses a new session's initial message without retaining a startup write", async () => {
  await withPendingStartupInspection(async ({ context, client, complete, admission }) => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
      assertAgentDatabaseAdmitted("main");
      respond(true, { message: "accepted" });
    });
    const respond = vi.fn();
    const request = handleGatewayRequest({
      req: {
        type: "req",
        id: "startup-write",
        method: "sessions.create",
        params: { agentId: "main", message: "hello" },
      },
      context,
      client,
      respond,
      isWebchatConnect: () => false,
      extraHandlers: { "sessions.create": handler },
    });
    await request;
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledExactlyOnceWith(
      false,
      undefined,
      expect.objectContaining({
        code: "UNAVAILABLE",
        retryable: true,
        details: { reason: "startup-sidecars", method: "sessions.create" },
      }),
    );
    complete();
    await admission.pendingPreparation;
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledOnce();
  });
});

it.each(["before", "after refusal"] as const)(
  "preserves terminal inspection failure %s write authorization",
  async (when) => {
    await withPendingStartupInspection(async ({ request, fail, admission }) => {
      const authorize = () =>
        authorizeGatewayRequestPreDispatch({
          ...request,
          method: "sessions.send",
          requestParams: { key: "agent:main:startup", message: "hello" },
        });
      if (when === "after refusal") {
        await expect(authorize()).resolves.toMatchObject({
          error: { code: "UNAVAILABLE", retryable: true },
        });
      }
      fail(new Error("synthetic failed inspection"));
      await admission.pendingPreparation;
      await expect(authorize()).resolves.toMatchObject({
        error: {
          code: "UNAVAILABLE",
          message: expect.stringContaining("synthetic failed inspection"),
          retryable: false,
        },
      });
    });
  },
);

it("admits an unrelated agent's write while startup preparation continues", async () => {
  await withPendingStartupInspection(async ({ request, context }) => {
    context.getRuntimeConfig = () => ({ agents: { entries: { main: {}, ready: {} } } });
    await expect(
      authorizeGatewayRequestPreDispatch({
        ...request,
        method: "sessions.create",
        requestParams: { agentId: "ready", message: "hello" },
      }),
    ).resolves.toMatchObject({ error: null });
    expect(readAgentDatabaseAdmissionRefusal("main")?.code).toBe(
      "agent-database-inspection-pending",
    );
  });
});

it("refuses a write while its logical agent's physical shared-store owner is pending", async () => {
  await withPendingStartupInspection(
    async ({ request, context, databasePath, complete, admission }) => {
      useSharedStore(context, databasePath);
      const authorize = () =>
        authorizeGatewayRequestPreDispatch({
          ...request,
          method: "sessions.create",
          requestParams: { agentId: "ops", message: "hello" },
        });
      await expect(authorize()).resolves.toMatchObject({
        error: {
          code: "UNAVAILABLE",
          retryable: true,
          details: { reason: "startup-sidecars", method: "sessions.create" },
        },
      });
      expect(() => assertAgentDatabaseAdmitted("ops")).not.toThrow();
      complete();
      await admission.pendingPreparation;
      await expect(authorize()).resolves.toMatchObject({ error: null });
    },
  );
});

it.each([
  ["sessions.list", { agentId: "main" }],
  ["sessions.resolve", { key: "agent:main:startup" }],
  ["sessions.resolve", { sessionId: "startup" }],
  ["sessions.describe", { key: "agent:main:startup" }],
  ["models.list", {}],
  ["models.list", { sessionKey: "agent:main:startup" }],
] as const)(
  "holds %s reads until their startup inspection publishes (%j)",
  async (method, params) => {
    await withPendingStartupInspection(async ({ dispatch, complete }) => {
      const handler = vi.fn<GatewayRequestHandler>(({ respond }) => {
        assertAgentDatabaseAdmitted("main");
        respond(true, { read: "committed" });
      });
      const respond = vi.fn();
      const request = dispatch({ type: "req", id: "startup-read", method, params }, respond, {
        [method]: handler,
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).not.toHaveBeenCalled();
      expect(respond).not.toHaveBeenCalled();
      expect(() => assertAgentDatabaseAdmitted("main")).toThrow("synthetic inspection");
      complete();
      await request;
      expect(handler).toHaveBeenCalledOnce();
      expect(respond).toHaveBeenCalledExactlyOnceWith(true, { read: "committed" });
    });
  },
);

it("dispatches broad lists while an agent remains in startup preparation", async () => {
  await withPendingStartupInspection(async ({ dispatch }) => {
    const handler = vi.fn<GatewayRequestHandler>(({ respond }) => respond(true, { sessions: [] }));
    const respond = vi.fn();
    const request = dispatch(
      { type: "req", id: "broad-startup-list", method: "sessions.list", params: {} },
      respond,
      { "sessions.list": handler },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(handler).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledExactlyOnceWith(true, { sessions: [] });
    expect(readAgentDatabaseAdmissionRefusal("main")?.code).toBe(
      "agent-database-inspection-pending",
    );
    await request;
  });
});

it("holds a logical agent's read for the physical shared-store owner", async () => {
  await withPendingStartupInspection(async ({ request, context, databasePath, complete }) => {
    useSharedStore(context, databasePath);
    let settled = false;
    const reading = authorizeGatewayRequestPreDispatch({
      ...request,
      method: "sessions.list",
      requestParams: { agentId: "ops" },
    }).then((result) => {
      settled = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    expect(() => assertAgentDatabaseAdmitted("ops")).not.toThrow();
    expect(() => assertAgentDatabaseAdmitted("main")).toThrow("synthetic inspection");
    complete();
    await expect(reading).resolves.toMatchObject({ error: null });
  });
});

it.each(["ready", "revoked", "changed config", "timeout", "cancelled"] as const)(
  "settles startup discovery after %s before dispatch",
  async (outcome) => {
    await withPendingStartupInspection(
      async ({ request, context, client, databasePath, complete }) => {
        let liveConfig: OpenClawConfig = cfg;
        context.getRuntimeConfig = () => liveConfig;
        const discovery =
          createDeferredCore<
            Awaited<ReturnType<typeof sqliteTarget.prepareSqliteTargetFromSessionStorePath>>
          >();
        let discoverySignal: AbortSignal | undefined;
        const prepare = vi
          .spyOn(sqliteTarget, "prepareSqliteTargetFromSessionStorePath")
          .mockImplementation((_storePath, _options, signal) => {
            discoverySignal = signal;
            if (liveConfig !== cfg) {
              return Promise.resolve({ agentId: "main", path: databasePath });
            }
            return racePromiseWithAbortSignal(discovery.promise, signal);
          });
        const controller = new AbortController();
        const reading = authorizeGatewayRequestPreDispatch({
          ...request,
          method: "sessions.list",
          requestParams: { agentId: "healthy" },
          signal: controller.signal,
        });
        const cancelled =
          outcome === "cancelled"
            ? expect(reading).rejects.toMatchObject({ name: "AbortError" })
            : undefined;
        await vi.advanceTimersByTimeAsync(0);
        expect(discoverySignal?.aborted).toBe(false);
        if (outcome === "cancelled") {
          controller.abort();
          await cancelled;
        } else if (outcome === "timeout") {
          await vi.advanceTimersByTimeAsync(20_000);
          await expect(reading).resolves.toMatchObject({
            error: { code: "UNAVAILABLE", retryable: true },
          });
        } else {
          if (outcome === "revoked") {
            client.connect.scopes = [];
          } else if (outcome === "changed config") {
            liveConfig = { ...cfg, session: { store: databasePath } };
          }
          discovery.resolve({ agentId: "healthy", path: databasePath });
          if (outcome === "changed config") {
            await vi.advanceTimersByTimeAsync(0);
            expect(prepare).toHaveBeenCalledTimes(2);
            complete();
          }
          await expect(reading).resolves.toMatchObject(
            outcome === "revoked" ? { error: { code: "FORBIDDEN" } } : { error: null },
          );
        }
        expect(prepare).toHaveBeenCalledTimes(outcome === "changed config" ? 2 : 1);
        expect(discoverySignal?.aborted).toBe(true);
      },
    );
  },
);

it("rechecks scopes after startup admission", async () => {
  await withPendingStartupInspection(async ({ request, client, complete }) => {
    const read = authorizeGatewayRequestPreDispatch(request);
    await vi.advanceTimersByTimeAsync(0);
    await expect(
      authorizeGatewayRequestPreDispatch({
        ...request,
        method: "sessions.list",
        requestParams: { agentId: "healthy" },
      }),
    ).resolves.toMatchObject({ error: null });
    client.connect.scopes = [];
    complete();
    await expect(read).resolves.toMatchObject({ error: { code: "FORBIDDEN" } });
  });
});

it.each(["current", "revoked"] as const)(
  "bounds startup reads with %s authority without cancelling preparation or granting writes",
  async (authority) => {
    await withPendingStartupInspection(async ({ request, client, complete, admission }) => {
      const read = authorizeGatewayRequestPreDispatch(request);
      await vi.advanceTimersByTimeAsync(0);
      if (authority === "revoked") {
        client.connect.scopes = [];
      }
      await vi.advanceTimersByTimeAsync(20_000);
      await expect(read).resolves.toMatchObject(
        authority === "revoked"
          ? { error: { code: "FORBIDDEN", details: { code: "MISSING_SCOPE" } } }
          : {
              error: {
                code: "UNAVAILABLE",
                retryable: true,
                details: { code: "agent-database-inspection-pending" },
              },
            },
      );
      expect(admission.signal.aborted).toBe(false);
      expect(() => assertAgentDatabaseAdmitted("main")).toThrow("synthetic inspection");
      complete();
      await admission.pendingPreparation;
      expect(readAgentDatabaseAdmissionRefusal("main")).toBeUndefined();
    });
  },
);

it.each(["request", "connection", "observation"] as const)(
  "cancels startup waiting when the %s ends without stopping preparation",
  async (source) => {
    await withPendingStartupInspection(async ({ request, client, admission }) => {
      const controller = new AbortController();
      const scope = new AsyncWorkScope();
      if (source === "connection") {
        client.connectionSignal = controller.signal;
      }
      const read = scope.run(() =>
        authorizeGatewayRequestPreDispatch({
          ...request,
          method: "models.list",
          requestParams: {},
          ...(source === "request" ? { signal: controller.signal } : {}),
        }),
      );
      const cancelled = expect(read).rejects.toMatchObject({ name: "AbortError" });
      await vi.advanceTimersByTimeAsync(0);
      if (source === "observation") {
        scope.beginClose();
      } else {
        controller.abort();
      }
      await cancelled;
      expect(admission.signal.aborted).toBe(false);
      expect(() => assertAgentDatabaseAdmitted("main")).toThrow("synthetic inspection");
    });
  },
);

it("preserves the admin dispatch shortcut without preparing private rows", async () => {
  const { projection, request } = describeFixture();
  const prepare = vi.spyOn(projection, "withPreparedExactRows");
  Object.defineProperty(projection, "state", {
    get: () => {
      throw new Error("unexpected projection read before handler validation");
    },
  });
  await expect(authorizeGatewayRequestPreDispatch(request)).resolves.toEqual({ error: null });
  expect(prepare).not.toHaveBeenCalled();
});

it.each(["dispatch scopes", "private access"] as const)(
  "rechecks %s after row preparation",
  async (boundary) => {
    const { projection, context, client, dispatch } = describeFixture();
    const prepare = projection.withPreparedExactRows.bind(projection);
    const describe = vi.spyOn(projection, "describe");
    if (boundary === "dispatch scopes") {
      client.connect.scopes = ["operator.read"];
    }
    vi.spyOn(projection, "withPreparedExactRows").mockImplementationOnce(async (...args) => {
      await Promise.resolve();
      client.connect.scopes = boundary === "dispatch scopes" ? [] : ["operator.read"];
      if (boundary === "private access") {
        client.authenticatedUserProfile = {
          profileId: "identified-viewer",
          displayName: "Viewer",
          hasAvatar: false,
          updatedAt: 1,
        };
      }
      return prepare(...args);
    });
    if (boundary === "dispatch scopes") {
      const respond = vi.fn();
      await dispatch(
        {
          type: "req",
          id: "revoked-description",
          method: "sessions.describe",
          params: { key: query.key },
        },
        respond,
      );
      expect(respond).toHaveBeenCalledExactlyOnceWith(
        false,
        undefined,
        expect.objectContaining({ code: "FORBIDDEN" }),
      );
    } else {
      const respond = vi.fn();
      await sessionByKeyReadHandlers["sessions.describe"]!({
        req: { type: "req", id: "private-description", method: "sessions.describe" },
        params: { key: query.key },
        context,
        client,
        respond,
        isWebchatConnect: () => false,
      });
      expect(respond).toHaveBeenCalledExactlyOnceWith(false, undefined, {
        code: "INVALID_REQUEST",
        message: `Incognito session "${query.key}" was not found.`,
      });
      expect(describe).not.toHaveBeenCalled();
    }
  },
);

it.each(["operator.admin", "operator.read"])(
  "ends describe preparation after its %s connection closes",
  async (scope) => {
    const { projection, client, dispatch } = describeFixture();
    const connection = new AbortController();
    client.connect.scopes = [scope];
    client.connectionSignal = connection.signal;
    const prepareRows = projection.withPreparedExactRows.bind(projection);
    const prepare = vi
      .spyOn(projection, "withPreparedExactRows")
      .mockImplementationOnce(async (...args) => {
        await Promise.resolve();
        connection.abort(new Error("Requesting connection closed"));
        return prepareRows(...args);
      });
    const respond = vi.fn();
    try {
      await dispatch(
        {
          type: "req",
          id: "cancelled-description",
          method: "sessions.describe",
          params: { key: "agent:main:cancelled-read" },
        },
        respond,
      );
      expect(prepare).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
    }
  },
);

it.each(["disposed", "refreshed"] as const)(
  "consumes rows only from an active, ready frame: %s",
  async (preparation) => {
    const owner = createSessionRowProjectionFixture({ cfg, store: {} });
    const queries = vi.fn(() => [query]);
    const initial = owner.state;
    let current = initial;
    const state = vi.fn(() => current);
    if (preparation === "refreshed") {
      Object.defineProperty(owner, "state", { get: state });
      vi.spyOn(owner, "describe").mockImplementation(() => {
        current = {
          ...initial,
          rowContext: {
            ...initial.rowContext,
            configuredDefaultModelByAgent: new Map([
              ["main", { provider: "fixture", model: "fresh" }],
            ]),
          },
        };
        return undefined;
      });
    }
    const consume = vi.fn((read: SessionRowReadView) => {
      state.mockClear();
      expect(read.state.rowContext.configuredDefaultModelByAgent.get("main")).toEqual({
        provider: "fixture",
        model: "fresh",
      });
      expect(read.describe(query)).toBeUndefined();
      expect(state).not.toHaveBeenCalled();
    });
    try {
      const read = () =>
        readPreparedSessionRows(owner, () => preparation !== "disposed", queries, consume);
      if (preparation === "disposed") {
        expect(read).toThrow("no longer active");
        expect(queries).not.toHaveBeenCalled();
      } else {
        read();
      }
      if (preparation !== "refreshed") {
        expect(consume).not.toHaveBeenCalled();
      }
    } finally {
      owner.dispose();
    }
  },
);

it.each(["child", "parent"] as const)(
  "rechecks %s membership after placement preparation and consumes the exact frame once",
  async (changed) => {
    setRuntimeConfigSnapshot(cfg);
    const child = { agentId: "main", key: "agent:main:prepared-child" };
    const parent = { agentId: "main", key: "agent:main:prepared-parent" };
    const projection = createSessionRowProjectionFixture({
      cfg,
      store: {
        [child.key]: { sessionId: "child", updatedAt: 1, parentSessionKey: parent.key },
        [parent.key]: { sessionId: "parent", updatedAt: 1 },
      },
    });
    const placementStarted = createDeferredCore();
    const placementReply = createDeferredCore<WorkerSessionPlacementProjection>();
    const membershipStarted = createDeferredCore();
    const membershipReady = createDeferredCore();
    const snapshot: WorkerSessionPlacementProjection = {
      placements: new Map(),
      moves: new Map(),
      pendingResults: new Map(),
      workspaceJournalOwnerSessionIds: new Set(),
      environments: new Map(),
      workspaceResultReconcilingSessionIds: new Set(),
      workspaceRecoveryPendingSessionIds: new Set(),
    };
    const readPlacement = vi
      .fn()
      .mockImplementationOnce(() => {
        placementStarted.resolve();
        return placementReply.promise;
      })
      .mockResolvedValue(snapshot);
    const placementFacts = createSessionRowPlacementProjection(
      { readProjection: readPlacement },
      () => undefined,
    );
    let dirtyKey: string | undefined;
    const prepareMembership = vi.fn(async () => {
      membershipStarted.resolve();
      await membershipReady.promise;
      dirtyKey = undefined;
    });
    const exact = createSessionRowAncestorReads({
      state: () => ({ cfg, context: projection.state.rowContext }),
      referenced: (key) => projection.describe({ agentId: "main", key }),
      lookup: projection.describe,
      prepareExactRows: () => undefined,
      prepareSelection: () => undefined,
      retainExactPreparation: () => () => {},
      retainArchiveRows: () => ({ update: () => {}, release: () => {} }),
      describe: projection.describe,
      inOwnerContext: AsyncLocalStorage.snapshot(),
      placementFacts,
      membership: {
        prepare: prepareMembership,
        needsPreparation: (queries) => queries(cfg).some(({ key }) => key === dirtyKey),
      },
      isActive: () => true,
      projection: () => projection,
    });
    const consume = vi.fn((read: SessionRowReadView) => {
      expect(dirtyKey).toBeUndefined();
      expect(placementFacts.isPrepared("child")).toBe(true);
      expect(placementFacts.isPrepared("parent")).toBe(true);
      const row = expectDefined(read.describe(child), "prepared child row");
      return exact.ancestorRows(row)?.map(({ key }) => key);
    });
    try {
      const prepared = exact.withPreparedExactRows(() => [child], consume, {
        includeAncestors: true,
      });
      await Promise.race([placementStarted.promise, prepared]);
      dirtyKey = changed === "child" ? child.key : parent.key;
      placementReply.resolve(snapshot);
      expect(
        await Promise.race([
          membershipStarted.promise.then(() => "membership"),
          prepared.then(() => "consumed"),
        ]),
      ).toBe("membership");
      expect(consume).not.toHaveBeenCalled();
      membershipReady.resolve();
      await expect(prepared).resolves.toEqual([parent.key]);
      expect(prepareMembership).toHaveBeenCalledOnce();
      expect(consume).toHaveBeenCalledOnce();
    } finally {
      placementReply.resolve(snapshot);
      membershipReady.resolve();
      placementFacts.dispose();
      projection.dispose();
    }
  },
);
