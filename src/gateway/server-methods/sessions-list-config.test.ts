import { afterEach, expect, it, vi } from "vitest";
import {
  createConfigResolutionFacts,
  setConfigResolutionFacts,
} from "../../config/resolution-facts.js";
import {
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { replaceSessionEntrySync } from "../../config/sessions/session-accessor.js";
import * as history from "../../config/sessions/session-transcript-worker-runtime.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
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
