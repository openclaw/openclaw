import { StatementSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { observeSqliteReadSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import * as acpReads from "../../acp/runtime/session-meta-readonly.js";
import { notifyPreparedModelRuntimePublication } from "../../agents/prepared-model-runtime.publication-events.js";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import {
  loadSessionEntry,
  replaceSessionEntrySync,
} from "../../config/sessions/session-accessor.js";
import * as history from "../../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { OperatorScope } from "../operator-scopes.js";
import { retainSessionListForegroundWork } from "../session-projection-work.js";
import { bindSessionRowProjection } from "../session-row-projection-access.js";
import { createSessionRowProjection } from "../session-row-projection.js";
import { createWorkerSessionPlacementStore } from "../worker-environments/placement-store.js";
import {
  identifiedClient,
  listSessions,
  requestContext,
} from "./sessions-read-cache.test-support.js";

afterEach(() => vi.restoreAllMocks());

it("reuses committed row facts when a changed model catalog updates session lists", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: { utilityModel: "unit-test/small" },
      },
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(cfg);
    const scopes = ["first", "second"].map((name) => ({
      agentId: "main",
      sessionKey: `agent:main:catalog-${name}`,
    }));
    for (const scope of scopes) {
      replaceSessionEntrySync(scope, {
        sessionId: scope.sessionKey,
        updatedAt: 1,
        visibility: "shared",
        providerOverride: "unit-test",
        modelOverride: "fixture",
        activitySummary: {
          version: 1,
          formatRevision: 2,
          text: "Ready",
          updatedAt: 1,
          sessionId: scope.sessionKey,
          generation: null,
          maxSeq: null,
          leafEntryId: null,
          coveredMessages: 0,
          totalMessages: 0,
          omittedContent: false,
        },
      });
    }
    let catalog = [{ id: "fixture", name: "Fixture", provider: "unit-test", contextTokens: 8192 }];
    const release = retainSessionListForegroundWork();
    const projection = await createSessionRowProjection({
      cfg,
      getModelCatalog: async () => catalog,
    });
    const context = bindSessionRowProjection(requestContext(cfg), () => projection);
    const client = identifiedClient("viewer");
    const list = () => listSessions({ context, client, request: { includeActivitySummary: true } });
    try {
      expect((await list()).sessions.map((row) => row.contextTokens)).toEqual([8192, 8192]);
      const reads: string[] = [];
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        (targets, consume) =>
          readDatabases(targets, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                readRowFacts(input) {
                  reads.push(...input.sessionKeys);
                  return owner.readRowFacts(input);
                },
              })),
            ),
          ),
      );
      const acp = vi.spyOn(acpReads, "readAcpSessionMetaForEntries");
      const hostReads = observeSqliteReadSql(StatementSync.prototype);
      try {
        catalog = [{ ...catalog[0]!, contextTokens: 16384 }];
        notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
        const result = await list();
        expect(result.sessions).toHaveLength(2);
        for (const row of result.sessions) {
          expect(row).toMatchObject({
            contextTokens: 16384,
            activitySummary: { text: "Ready", state: "current" },
          });
        }
        expect(reads).toEqual([]);
        expect(acp).not.toHaveBeenCalled();
        expect(
          hostReads.queries.filter((sql) =>
            /session_nodes|board_tabs|transcript_rewrite_watermarks|acp_sessions/.test(sql),
          ),
        ).toEqual([]);
      } finally {
        hostReads.restore();
      }

      // A catalog publication cannot turn an in-flight stored update into stale presentation.
      const captured = createDeferredCore();
      const resume = createDeferredCore();
      const first = scopes[0]!;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        (targets, consume) =>
          readDatabases(targets, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                async readRowFacts(input) {
                  reads.push(...input.sessionKeys);
                  const result = await owner.readRowFacts(input);
                  captured.resolve();
                  await resume.promise;
                  return result;
                },
              })),
            ),
          ),
      );
      replaceSessionEntrySync(first, {
        ...loadSessionEntry(first)!,
        label: "Committed during renewal",
      });
      const listing = list();
      try {
        await captured.promise;
        catalog = [{ ...catalog[0]!, contextTokens: 32768 }];
        notifyPreparedModelRuntimePublication({ phase: "catalog-published" });
      } finally {
        resume.resolve();
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
  });
});

it("retains session facts on identity-scope changes and refreshes changes that affect the rows", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    let cfg: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true }],
        defaults: { model: "unit-test/original" },
      },
      plugins: { enabled: false },
    };
    setRuntimeConfigSnapshot(cfg);
    const scope = { agentId: "main", sessionKey: "agent:main:live" };
    for (const name of ["live", "archived"]) {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: `agent:main:${name}` },
        {
          sessionId: name,
          updatedAt: 1,
          visibility: "shared",
          ...(name === "archived" ? { archivedAt: 1 } : {}),
        },
      );
    }
    const context = requestContext(cfg);
    context.getRuntimeConfig = () => getRuntimeConfigSnapshot()!;
    const release = retainSessionListForegroundWork();
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
      const readDatabases = history.withSessionHistoryWorkerDatabases;
      vi.spyOn(history, "withSessionHistoryWorkerDatabases").mockImplementation(
        (targets, consume) =>
          readDatabases(targets, (owners) =>
            consume(
              owners.map((owner) => ({
                ...owner,
                readRowFacts(input) {
                  reads.push(...input.sessionKeys);
                  return owner.readRowFacts(input);
                },
              })),
            ),
          ),
      );
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
        if (refresh) {
          expect(reads.length).toBeGreaterThan(0);
          expect(projection.materializedCount).toBeGreaterThan(materialized);
        } else {
          expect(reads).toEqual([]);
          expect(projection.materializedCount).toBe(materialized);
        }
        return result;
      };
      for (const scopes of [["operator.read"], ["operator.admin"]] satisfies OperatorScope[][]) {
        await publish(
          { ...cfg, gateway: { auth: { identityScopes: { "viewer@example.test": scopes } } } },
          false,
        );
      }
      const { gateway: _gateway, ...withoutGateway } = cfg;
      await publish(withoutGateway, false);

      // A policy publication must retain work already queued by a committed session write.
      reads.length = 0;
      replaceSessionEntrySync(scope, {
        sessionId: "live",
        updatedAt: 1,
        visibility: "shared",
        label: "Changed during reload",
      });
      cfg = {
        ...cfg,
        gateway: { auth: { identityScopes: { "viewer@example.test": ["operator.read"] } } },
      };
      setRuntimeConfigSnapshot(cfg);
      expect((await list()).sessions.find((row) => row.key === scope.sessionKey)?.label).toBe(
        "Changed during reload",
      );
      expect(reads).toEqual([scope.sessionKey]);

      const changedModel = await publish(
        {
          ...cfg,
          agents: { ...cfg.agents, defaults: { model: "unit-test/changed" } },
          gateway: { auth: { identityScopes: { "viewer@example.test": ["operator.admin"] } } },
        },
        true,
      );
      expect(changedModel.sessions.map((row) => row.model)).toEqual(["changed", "changed"]);

      for (const [index, facts] of [
        createConfigResolutionFacts([]),
        createConfigResolutionFacts([], new Map([["models.providers.unit.apiKey", "UNIT_KEY"]])),
        createConfigResolutionFacts(
          [],
          new Map(),
          undefined,
          new Map([["models.providers.unit.apiKey", "UNIT_KEY"]]),
        ),
      ].entries()) {
        const next: OpenClawConfig = {
          ...cfg,
          gateway: {
            auth: {
              identityScopes: {
                "viewer@example.test": [index % 2 === 0 ? "operator.read" : "operator.admin"],
              },
            },
          },
        };
        setConfigResolutionFacts(next, facts);
        await publish(next, true);
      }

      reads.length = 0;
      const forced: OpenClawConfig = {
        ...cfg,
        gateway: { auth: { identityScopes: { "viewer@example.test": ["operator.admin"] } } },
      };
      setConfigResolutionFacts(
        forced,
        createConfigResolutionFacts(
          [],
          new Map(),
          undefined,
          new Map([["models.providers.unit.apiKey", "UNIT_KEY"]]),
        ),
      );
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
  });
});
