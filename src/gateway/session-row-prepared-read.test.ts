import { AsyncLocalStorage } from "node:async_hooks";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  deferCanonicalSessionValidation,
  type PendingCanonicalValidation,
} from "../config/sessions/session-canonical-validation-deferral.js";
import { createDeferredCore } from "../shared/deferred.js";
import { registerOpenClawAgentDatabaseIdentity } from "../state/openclaw-agent-db-identity.js";
import { createRequestGatewayMethodRegistry, handleGatewayRequest } from "./server-methods.js";
import { authorizeGatewayRequestPreDispatch } from "./server-methods/request-authorization.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { createSessionRowPlacementProjection } from "./session-row-placement-projection.js";
import { withPreparedSessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import { createSessionRowAncestorReads } from "./session-row-projection-ancestors.js";
import { createSessionRowProjectionFixture } from "./session-row-projection.test-support.js";
import { sharingPolicyClient } from "./session-sharing.test-utils.js";
import type { WorkerSessionPlacementProjection } from "./worker-environments/placement-read-projection.types.js";

const certifyReadiness = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("../config/sessions/session-canonical-validation-readiness.js", () => ({
  certifySessionCanonicalValidationPending: certifyReadiness,
}));

afterEach(() => {
  vi.restoreAllMocks();
  certifyReadiness.mockReset();
  vi.unstubAllEnvs();
});

const cfg = { agents: { entries: { main: {} } } };
const query = { agentId: "main", key: "agent:main:dashboard:incognito-prepared" };
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function pendingDatabase(pathname: string): PendingCanonicalValidation {
  return {
    agentId: "main",
    path: pathname,
    initializeCanonicalValidation: true,
    assertStateCurrent: () => {},
    source: { key: "file:synthetic", canonicalPath: pathname, incarnation: "test" },
  };
}

function describeFixture() {
  const projection = createSessionRowProjectionFixture({ cfg, store: {} });
  projection.withPreparedExactRows = (queries, consume) =>
    withPreparedSessionRows(projection, () => true, queries, consume);
  const context = bindSessionRowProjection(requestContext(cfg), () => projection);
  const client = sharingPolicyClient({ scopes: ["operator.admin"] });
  const request = {
    method: "sessions.describe",
    requestParams: { key: query.key },
    client,
    context,
    methodRegistry: createRequestGatewayMethodRegistry(),
  };
  return { projection, context, client, request };
}

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
  "rechecks %s after canonical description readiness",
  async (boundary) => {
    const { projection, context, client, request } = describeFixture();
    const database = pendingDatabase("/synthetic/parent.sqlite");
    vi.spyOn(projection, "withPreparedExactRows").mockResolvedValueOnce({
      kind: "pending",
      database,
    });
    const describe = vi.spyOn(projection, "describe");
    if (boundary === "dispatch scopes") {
      client.connect.scopes = ["operator.read"];
    }
    certifyReadiness.mockImplementationOnce(async () => {
      client.connect.scopes = boundary === "dispatch scopes" ? [] : ["operator.read"];
      if (boundary === "private access") {
        client.authenticatedUserProfile = {
          profileId: "identified-viewer",
          displayName: "Viewer",
          hasAvatar: false,
          updatedAt: 1,
        };
      }
    });
    if (boundary === "dispatch scopes") {
      await expect(authorizeGatewayRequestPreDispatch(request)).resolves.toMatchObject({
        error: { code: "FORBIDDEN", details: { code: "MISSING_SCOPE" } },
      });
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
    expect(certifyReadiness).toHaveBeenCalledExactlyOnceWith(database);
  },
);

it.each(["operator.admin", "operator.read"])(
  "ends describe readiness retries after its %s connection closes",
  async (scope) => {
    const { projection, context, client } = describeFixture();
    const connection = new AbortController();
    client.connect.scopes = [scope];
    client.connectionSignal = connection.signal;
    const prepare = vi.spyOn(projection, "withPreparedExactRows").mockResolvedValueOnce({
      kind: "pending",
      database: pendingDatabase("/synthetic/cancelled.sqlite"),
    });
    certifyReadiness.mockImplementationOnce(async () => {
      connection.abort(new Error("Requesting connection closed"));
    });
    const respond = vi.fn();
    try {
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "cancelled-description",
          method: "sessions.describe",
          params: { key: "agent:main:cancelled-read" },
        },
        context,
        client,
        respond,
        isWebchatConnect: () => false,
        extraHandlers: sessionByKeyReadHandlers,
      });
      expect(certifyReadiness).toHaveBeenCalledOnce();
      expect(prepare).toHaveBeenCalledOnce();
      expect(respond).not.toHaveBeenCalled();
    } finally {
      projection.dispose();
    }
  },
);

it.each(["disposed", "pending", "refreshed"] as const)(
  "consumes private rows only from an active, ready frame: %s",
  async (preparation) => {
    const owner = createSessionRowProjectionFixture({ cfg, store: {} });
    const queries = vi.fn(() => [query]);
    let database: DatabaseSync | undefined;
    let originalStateDir: string | undefined;
    let placement: ReturnType<typeof createSessionRowPlacementProjection> | undefined;
    const initial = owner.state;
    let current = initial;
    const state = vi.fn(() => current);
    if (preparation === "pending") {
      originalStateDir = tempDirs.make("session-row-pending-");
      vi.stubEnv("OPENCLAW_STATE_DIR", originalStateDir);
      const db = new DatabaseSync(path.join(originalStateDir, "parent.sqlite"));
      database = db;
      registerOpenClawAgentDatabaseIdentity(db);
      placement = createSessionRowPlacementProjection(undefined, () => undefined);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(originalStateDir, "changed-root"));
      vi.spyOn(owner, "describe").mockImplementation(() => {
        deferCanonicalSessionValidation({ agentId: "main", db }, false);
        return undefined;
      });
    } else if (preparation === "refreshed") {
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
      const reading = placement
        ? placement.withPreparedRows(
            owner,
            () => true,
            () => undefined,
            queries,
            () => undefined,
            consume,
          )
        : withPreparedSessionRows(owner, () => preparation !== "disposed", queries, consume);
      if (preparation === "disposed") {
        await expect(reading).rejects.toThrow("no longer active");
        expect(queries).not.toHaveBeenCalled();
      } else if (preparation === "pending") {
        await expect(reading).resolves.toMatchObject({
          kind: "pending",
          database: {
            agentId: "main",
            path: expectDefined(database, "pending database").location(),
            initializeCanonicalValidation: false,
            env: { OPENCLAW_STATE_DIR: originalStateDir },
          },
        });
      } else {
        await reading;
      }
      if (preparation !== "refreshed") {
        expect(consume).not.toHaveBeenCalled();
      }
    } finally {
      placement?.dispose();
      database?.close();
    }
  },
);

it.each(["child", "parent"] as const)(
  "rechecks %s membership after placement preparation and consumes the exact frame once",
  async (changed) => {
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
      assertExactRowsPrepared: () => {},
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
      await expect(prepared).resolves.toEqual({ kind: "complete", value: [parent.key] });
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
