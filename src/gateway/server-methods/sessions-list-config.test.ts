import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { ACTIVITY_SUMMARY_FORMAT_REVISION } from "../../config/sessions/activity-summary.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as history from "../../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import * as sharedReads from "../../state/openclaw-state-db-readonly.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OperatorScope } from "../operator-scopes.js";
import * as projectionWork from "../session-projection-work.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { watchRowFacts } from "../session-row-projection.read-fixture.test-support.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

function config(defaults: NonNullable<OpenClawConfig["agents"]>["defaults"]): OpenClawConfig {
  const cfg = { agents: { entries: { main: {} }, defaults }, plugins: { enabled: false } };
  setRuntimeConfigSnapshot(cfg);
  return cfg;
}

function seed(name: string, patch: Partial<Parameters<typeof replaceSessionEntrySync>[1]>) {
  const scope = { agentId: "main", sessionKey: `agent:main:${name}` };
  replaceSessionEntrySync(scope, {
    sessionId: scope.sessionKey,
    updatedAt: 1,
    visibility: "shared",
    ...patch,
  });
  return scope;
}

function withScopes(cfg: OpenClawConfig, scopes: OperatorScope[]): OpenClawConfig {
  return { ...cfg, gateway: { auth: { identityScopes: { "viewer@example.test": scopes } } } };
}

function observeRowFacts(reads: string[], pause?: () => Promise<void>) {
  vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockRestore();
  watchRowFacts((owner) => async (input) => {
    reads.push(...input.sessionKeys);
    const rows = await owner.readRowFacts(input);
    if (pause) {
      await pause();
    }
    return rows;
  });
}

function pauseRowFacts(reads: string[]) {
  const captured = createDeferredCore();
  const resume = createDeferredCore();
  let first = true;
  observeRowFacts(reads, async () => {
    if (first) {
      first = false;
      captured.resolve();
      await resume.promise;
    }
  });
  return { captured: captured.promise, resume: () => resume.resolve() };
}

it("reuses committed row facts when a changed model catalog updates session lists", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg = config({ utilityModel: "unit-test/small" });
    const scopes = ["first", "second"].map((name) =>
      seed(`catalog-${name}`, {
        providerOverride: "unit-test",
        modelOverride: "fixture",
        activitySummary: {
          version: 1,
          formatRevision: ACTIVITY_SUMMARY_FORMAT_REVISION,
          text: "Ready",
          updatedAt: 1,
          sessionId: `agent:main:catalog-${name}`,
          generation: null,
          maxSeq: null,
          leafEntryId: null,
          coveredMessages: 0,
          totalMessages: 0,
          omittedContent: false,
        },
      }),
    );
    let catalog = [{ id: "fixture", name: "Fixture", provider: "unit-test", contextTokens: 8192 }];
    const release = projectionWork.retainSessionListForegroundWork();
    const backgroundRefresh = createDeferredCore();
    const startupReads: string[] = [];
    const firstRead = pauseRowFacts(startupReads);
    const createDrain = projectionWork.createSessionProjectionDrain;
    vi.spyOn(projectionWork, "createSessionProjectionDrain").mockImplementation((options) =>
      createDrain({
        ...options,
        refresh() {
          const work = options.refresh();
          backgroundRefresh.resolve();
          return work;
        },
      }),
    );
    const creating = createSessionRowProjection({
      cfg,
      getModelCatalog: async () => catalog,
    });
    try {
      await firstRead.captured;
      await backgroundRefresh.promise;
      await projectionWork.yieldSessionListWork();
    } finally {
      firstRead.resume();
    }
    const projection = await creating;
    await projection.ensureMaterialized();
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const client = identifiedClient("viewer");
    const list = () => listSessions({ context, client, request: { includeActivitySummary: true } });
    try {
      expect(startupReads.toSorted()).toEqual(scopes.map((scope) => scope.sessionKey).toSorted());
      expect((await list()).sessions.map((row) => row.contextTokens)).toEqual([8192, 8192]);
      const reads: string[] = [];
      observeRowFacts(reads);
      const shared = vi.spyOn(sharedReads, "executeExistingOpenClawStateRead");
      const hostReads = observeSqliteReadSql(StatementSync.prototype);
      try {
        catalog = [{ ...catalog[0]!, contextTokens: 16384 }];
        notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
        const row = { contextTokens: 16384, activitySummary: { text: "Ready", state: "current" } };
        expect((await list()).sessions).toMatchObject([row, row]);
        expect([
          reads,
          shared.mock.calls.filter(([, command]) => command.type === "sessionRows.sharedFacts"),
          hostReads.queries.filter((sql) =>
            /session_nodes|board_tabs|transcript_rewrite_watermarks|acp_sessions/.test(sql),
          ),
        ]).toEqual([[], [], []]);
      } finally {
        hostReads.restore();
      }

      // A catalog publication cannot turn an in-flight stored update into stale presentation.
      const first = scopes[0]!;
      const renewalRead = pauseRowFacts(reads);
      replaceSessionEntrySync(first, {
        ...loadSessionEntry(first)!,
        label: "Committed during renewal",
      });
      sessionChanges.emit({ ...first, factsInvalidated: true });
      const listing = list();
      try {
        await renewalRead.captured;
        catalog = [{ ...catalog[0]!, contextTokens: 32768 }];
        notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      } finally {
        renewalRead.resume();
        await listing;
      }
      expect(reads).toEqual([first.sessionKey]);
      expect((await listing).sessions.find((row) => row.key === first.sessionKey)).toMatchObject({
        label: "Committed during renewal",
        contextTokens: 32768,
      });

      reads.length = 0;
      sessionChanges.emit({ all: true, scope: "catalog", factsInvalidated: true });
      await list();
      expect(new Set(reads)).toEqual(new Set(scopes.map((scope) => scope.sessionKey)));
    } finally {
      projection.dispose();
      release();
    }
  }));

it("retains session facts on identity-scope changes and refreshes changes that affect the rows", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg = config({ model: "unit-test/original" });
    const scope = { agentId: "main", sessionKey: "agent:main:live" };
    for (const name of ["live", "archived"]) {
      seed(name, { sessionId: name, ...(name === "archived" ? { archivedAt: 1 } : {}) });
    }
    const context = requestContext(cfg);
    context.getRuntimeConfig = () => getRuntimeConfigSnapshot()!;
    const release = projectionWork.retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      getConfig: () => context.getRuntimeConfig(),
      modelCatalog: [],
      placementFactsReader: createWorkerSessionPlacementStore(),
    });
    bindSessionRowProjection(context, () => projection);
    const client = identifiedClient("viewer");
    const list = () => listSessions({ context, client, request: { archived: "all" } });
    try {
      const original = await list();
      expect(original.totalCount).toBe(2);
      const reads: string[] = [];
      observeRowFacts(reads);
      const publish = async (next: OpenClawConfig, refresh: boolean) => {
        reads.length = 0;
        const materialized = projection.materializedCount;
        setRuntimeConfigSnapshot(next);
        cfg = next;
        const result = await list();
        expect(projection.state.cfg).toBe(next);
        expect(result.sessions.map((row) => row.key)).toEqual(
          original.sessions.map((row) => row.key),
        );
        const comparison = refresh ? "toBeGreaterThan" : "toBe";
        expect(reads.length)[comparison](0);
        expect(projection.materializedCount)[comparison](materialized);
        return result;
      };
      for (const scopes of [["operator.read"], ["operator.admin"]] satisfies OperatorScope[][]) {
        await publish(withScopes(cfg, scopes), false);
      }
      const { gateway: _gateway, ...withoutGateway } = cfg;
      await publish(withoutGateway, false);

      // A policy publication must retain work already queued by a committed session write.
      reads.length = 0;
      seed("live", {
        sessionId: "live",
        label: "Changed during reload",
      });
      cfg = withScopes(cfg, ["operator.read"]);
      setRuntimeConfigSnapshot(cfg);
      expect((await list()).sessions.find((row) => row.key === scope.sessionKey)?.label).toBe(
        "Changed during reload",
      );
      expect(reads).toEqual([]);

      const changedModel = await publish(
        withScopes(
          { ...cfg, agents: { ...cfg.agents, defaults: { model: "unit-test/changed" } } },
          ["operator.admin"],
        ),
        true,
      );
      expect(changedModel.sessions.map((row) => row.model)).toEqual(["changed", "changed"]);

      reads.length = 0;
      const forced = withScopes(cfg, ["operator.admin"]);
      setConfigResolutionFacts(forced, createConfigResolutionFacts([]));
      context.getRuntimeConfig = () => forced;
      sessionChanges.emit({ all: true, scope: "config", factsInvalidated: true });
      await list();
      expect(projection.state.cfg).toBe(forced);
      expect(reads.length).toBeGreaterThan(0);

      context.getRuntimeConfig = () => getRuntimeConfigSnapshot()!;
      cfg = forced;
      cfg.agents = { ...cfg.agents, defaults: { model: "unit-test/in-place" } };
      setRuntimeConfigSnapshot(cfg);
      expect((await list()).sessions.map((row) => row.model)).toEqual(["in-place", "in-place"]);
    } finally {
      projection.dispose();
      await projection.ensureMaterialized();
      release();
    }
  }));
