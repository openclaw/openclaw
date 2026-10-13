import "../test-utils/prepare-compiled-subprocesses.js";
import assert from "node:assert/strict";
import { expect, it, vi } from "vitest";
import { observeHostDataSql } from "../../test/helpers/sqlite-statement-execution-counter.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import {
  seedSubagentRunForReadTest,
  resetSubagentRegistryForTests,
} from "../agents/subagents/registry/subagent-registry.test-helpers.js";
import { replaceSessionEntrySync } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  readSqliteSessionArchivePruning,
  withSqliteSessionPageReclamation,
} from "../config/sessions/session-accessor.sqlite-page-reclamation.js";
import { restoreSessionColdTranscript } from "../config/sessions/session-cold-storage.js";
import { withIncognitoSessionBinding } from "../config/sessions/session-incognito-binding.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { withReadySessionRows, type SessionRowReadView } from "./session-row-prepared-read.js";
import { readResidentSessionRow } from "./session-row-projection-materialize.js";
import { withIncognitoSessionRow } from "./session-row-projection-read.js";
import type { Row } from "./session-row-projection-record.js";
import { createSessionRowProjection } from "./session-row-projection.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { presentSessionRow } from "./session-utils-row.js";
import * as sessionStoreLookup from "./session-utils-store-lookup.js";
import { reportPlacementTransition } from "./worker-environments/placement-record.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

// Two retained private actors plus shared-state reads need three broker slots.
vi.mock("../infra/worker-pool-sizing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/worker-pool-sizing.js")>()),
  resolveSqliteBrokerWorkerCount: () => 3,
}));

it("materializes actor-prepared private entries and lineage without host SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
    const incognitoReads = await import("./session-row-projection-read.js");
    openOpenClawStateDatabase({ env: state.env });
    const authority = { assertCurrent() {} };
    const actor = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "main",
      env: state.env,
      authority,
    });
    assert(actor);
    const other = await captureOpenClawAgentDatabaseExecution({
      kind: "ephemeral",
      agentId: "work",
      env: state.env,
      authority,
    });
    assert(other);
    try {
      const parentKey = "agent:main:dashboard:incognito-prepared-parent";
      const key = "agent:main:dashboard:incognito-prepared-row";
      const childKey = "agent:main:dashboard:incognito-prepared-child";
      const parent = await actor.sessions.create(authority, {
        sessionKey: parentKey,
        entry: {
          sessionId: "prepared-parent",
          updatedAt: Date.now(),
          providerOverride: "ollama",
          modelOverride: "qwen3:14b",
          modelOverrideSource: "user",
          modelOverrideRouteResolution: "resolved",
        },
      });
      const selected = await actor.sessions.create(authority, {
        sessionKey: key,
        entry: {
          sessionId: "prepared-row",
          updatedAt: Date.now(),
          label: "Prepared private row",
          parentSessionKey: parentKey,
        },
      });
      const child = await actor.sessions.create(authority, {
        sessionKey: childKey,
        entry: {
          sessionId: "prepared-child",
          updatedAt: Date.now(),
          parentSessionKey: key,
        },
      });
      assert(parent.entry && selected.entry && child.entry);
      for (const [role, content] of [
        ["user", "Private question"],
        ["assistant", "Private response"],
      ]) {
        const result = await actor.sessions.transcript(authority, {
          type: "session.message.append",
          input: {
            sessionKey: key,
            sessionId: "prepared-row",
            fence: {},
            message: { role, content },
          },
        });
        expect(result.ok).toBe(true);
      }
      const otherParentKey = "agent:work:dashboard:incognito-parent";
      await other.sessions.create(authority, {
        sessionKey: otherParentKey,
        entry: { ...parent.entry, sessionId: "other-parent" },
      });
      const durableParentKey = "agent:work:durable-parent";
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: durableParentKey, env: state.env },
        {
          ...parent.entry,
          incognito: undefined,
          sessionId: "durable-parent",
        },
      );
      const otherRoot = "agent:main:dashboard:incognito-other-parent";
      const durableRoot = "agent:main:dashboard:incognito-durable-parent";
      for (const [sessionKey, parentSessionKey] of [
        [otherRoot, otherParentKey],
        [durableRoot, durableParentKey],
      ] as const) {
        await actor.sessions.create(authority, {
          sessionKey,
          entry: { sessionId: sessionKey, updatedAt: Date.now(), parentSessionKey },
        });
      }
      const registryChild = "agent:work:subagent:incognito-registry-child";
      await other.sessions.create(authority, {
        sessionKey: registryChild,
        entry: { sessionId: "registry-child", updatedAt: Date.now() },
      });
      const durableChild = "agent:work:subagent:durable-registry-child";
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: durableChild, env: state.env },
        {
          sessionId: "durable-registry-child",
          updatedAt: Date.now(),
        },
      );
      const seedChild = (registeredChild: string) => {
        seedSubagentRunForReadTest({
          runId: registeredChild,
          childSessionKey: registeredChild,
          requesterSessionKey: key,
          requesterAgentId: "main",
          swarmRequesterSessionKey: key,
          collect: true,
          groupId: "private-projection-group",
          controllerSessionKey: key,
          task: "Synthetic child",
          cleanup: "keep",
          createdAt: Date.now(),
          startedAt: Date.now(),
        });
        subagentRuns.commitOwnership(subagentRuns.get(registeredChild)!);
      };
      for (const registeredChild of [registryChild, durableChild]) {
        seedChild(registeredChild);
      }
      const context = buildSessionListRowMetadataContext({
        now: Date.now(),
        sessionKeys: [parentKey, key, childKey],
      });
      const render = (row: Row | undefined) => {
        assert(row?.entry);
        return readResidentSessionRow({
          row: { ...row, entry: row.entry },
          cfg,
          modelCatalog: [],
          configuredAgentIds: new Set(["main"]),
          context,
          subagentInputs: context.subagentRuns.inputs,
          gatewayContext: undefined,
          links: [],
          readSourceEntry: () => undefined,
        });
      };
      const sql = observeHostDataSql();
      try {
        let retained: Row | undefined;
        await withIncognitoSessionRow({ actor, authority, cfg, env: state.env, key }, (row) => {
          retained = row;
          const prepared = render(row);
          expect(presentSessionRow(prepared.materialized, { now: Date.now() })).toMatchObject({
            key,
            sessionId: "prepared-row",
            incognito: true,
            label: "Prepared private row",
            model: "qwen3:14b",
            modelOverrideSource: "inherited",
            childSessions: [childKey, registryChild, durableChild],
            lastMessagePreview: "Private response",
          });
          expect(prepared.hasBoard).toBe(false);
        });
        expect(() => render(retained)).toThrow("consumer is no longer active");
        for (const root of [otherRoot, durableRoot]) {
          await withIncognitoSessionRow(
            { actor, authority, cfg, env: state.env, key: root },
            (row) => {
              expect(
                presentSessionRow(render(row).materialized, { now: Date.now() }),
              ).toMatchObject({
                key: root,
                model: "qwen3:14b",
                modelOverrideSource: "inherited",
              });
            },
          );
        }
        expect(sql.queries).toEqual([]);
      } finally {
        sql.restore();
      }
      await actor.sessions.create(authority, {
        sessionKey: "agent:main:dashboard:incognito-creator",
        entry: {
          sessionId: "private-creator",
          updatedAt: Date.now(),
          createdActor: {
            type: "human",
            source: "profile",
            id: "private-author",
            label: "Private author",
          },
        },
      });
      const missingChildren = [
        "agent:work:subagent:incognito-missing-child",
        "agent:work:subagent:missing-durable-child",
      ];
      for (const missingChildKey of missingChildren) {
        seedChild(missingChildKey);
      }
      const placements = createWorkerSessionPlacementStore();
      const projection = await createSessionRowProjection({
        cfg,
        placementFactsReader: placements,
      });
      const selectEntries = projection.selectEntries.bind(projection);
      const childLookup = vi.spyOn(projection, "selectEntries").mockImplementation((query) => {
        if (query?.key && missingChildren.includes(query.key)) {
          throw new Error("Captured absent child was rediscovered outside its prepared owner");
        }
        return selectEntries(query);
      });
      let placement: Awaited<ReturnType<typeof placements.startDispatch>> | undefined;
      const readPlacement = placements.readProjection.bind(placements);
      const placementGap = vi
        .spyOn(placements, "readProjection")
        .mockImplementation(async (...args) => {
          const snapshot = await readPlacement(...args);
          if (!placement && args[0].includes("prepared-row")) {
            placement = await placements.startDispatch({
              agentId: actor.agentId,
              sessionKey: key,
              sessionId: "prepared-row",
            });
            reportPlacementTransition(undefined, placement);
          }
          return snapshot;
        });
      try {
        await withIncognitoSessionBinding({ actor }, async () => {
          const appearingKey = "agent:main:dashboard:incognito-created-during-preparation";
          const readBeforeCreation = actor.sessions.readRow.bind(actor.sessions);
          const creationGap = vi
            .spyOn(actor.sessions, "readRow")
            .mockImplementationOnce(async (...args) => {
              await actor.sessions.create(authority, {
                sessionKey: appearingKey,
                entry: {
                  sessionId: "created-during-preparation",
                  incognito: true,
                  updatedAt: Date.now(),
                },
              });
              const createdPlacement = await placements.startDispatch({
                agentId: actor.agentId,
                sessionKey: appearingKey,
                sessionId: "created-during-preparation",
              });
              reportPlacementTransition(undefined, createdPlacement);
              return readBeforeCreation(...args);
            });
          const consumeAppearing = vi.fn((read: SessionRowReadView) => {
            const row = read.describe({ agentId: actor.agentId, key: appearingKey });
            assert(row);
            return read.present(row);
          });
          try {
            const appearing = await withReadySessionRows(
              projection,
              () => [{ agentId: actor.agentId, key: appearingKey }],
              consumeAppearing,
            );
            expect(appearing.placement?.state).toBe("requested");
            expect(consumeAppearing).toHaveBeenCalledTimes(1);
          } finally {
            creationGap.mockRestore();
          }
          let presentations = 0;
          const describe = (selectedKeys = [key, durableRoot]) =>
            withReadySessionRows(
              projection,
              () =>
                selectedKeys.map((selectedKey) => ({ agentId: actor.agentId, key: selectedKey })),
              (read) => {
                presentations++;
                if (selectedKeys.includes(key)) {
                  for (const [preparedChildKey, storePath, sessionId] of [
                    [registryChild, other.path, "registry-child"],
                    [
                      durableChild,
                      resolveOpenClawAgentSqlitePath({ agentId: "work", env: state.env }),
                      "durable-registry-child",
                    ],
                  ] as const) {
                    expect(read.selectEntries({ key: preparedChildKey })).toMatchObject([
                      {
                        agentId: "work",
                        storeTarget: { agentId: "work", storePath },
                        entry: { sessionId },
                        storedEntry: { sessionId },
                        sharingEntry: { sessionId },
                      },
                    ]);
                  }
                  for (const missingChildKey of missingChildren) {
                    expect(read.selectEntries({ key: missingChildKey })).toEqual([]);
                  }
                }
                return selectedKeys.map((selectedKey) => {
                  const row = read.describe({ agentId: actor.agentId, key: selectedKey });
                  assert(row);
                  expect(
                    projection.describe(
                      {
                        agentId: actor.agentId,
                        key: "agent:main:dashboard:incognito-other-target",
                      },
                      row,
                    ),
                  ).toBeUndefined();
                  return read.present(row, { now: Date.now() });
                });
              },
            );
          const described = await describe();
          expect(described.map((row) => row.key)).toEqual([key, durableRoot]);
          expect(described[0]?.placement?.state).toBe("requested");
          expect(presentations).toBe(1);
          const readRow = actor.sessions.readRow.bind(actor.sessions);
          const privateGap = vi
            .spyOn(actor.sessions, "readRow")
            .mockImplementationOnce(async (...args) => {
              const result = await readRow(...args);
              assert(placement);
              placement = await placements.transition({
                sessionId: "prepared-row",
                from: "requested",
                to: "provisioning",
                expectedGeneration: placement.generation,
              });
              reportPlacementTransition(undefined, placement);
              return result;
            });
          try {
            expect((await describe([key]))[0]?.placement?.state).toBe("provisioning");
            expect(presentations).toBe(2);
          } finally {
            privateGap.mockRestore();
          }
          // Observe the read after the independent placement writer's grants have settled.
          const statements = observeHostDataSql();
          try {
            expect((await describe([key]))[0]?.placement?.state).toBe("provisioning");
            expect(projection.listCreatedActors()).toContainEqual(
              expect.objectContaining({ id: "private-author" }),
            );
            expect(
              projection
                .findBySessionId({ sessionId: "prepared-row", federated: true })
                .map((row) => row.key),
            ).toEqual([key]);
            expect(() => projection.snapshot({ agentId: actor.agentId, key })).toThrow(
              "awaited row preparation",
            );
            for (const includeMembership of [false, true]) {
              let escaped: (() => void) | undefined;
              await sessionStoreLookup.withGatewaySessionStoreTarget(
                { cfg, agentId: actor.agentId, key, env: state.env, includeMembership },
                (target, membership, assertCurrent) => {
                  escaped = assertCurrent;
                  expect(target.store[key]?.sessionId).toBe("prepared-row");
                  expect(membership.has(key)).toBe(includeMembership);
                },
              );
              expect(escaped).toBeDefined();
              expect(() => escaped?.()).toThrow("no longer retained");
            }
            expect(
              projection.selectEntries().some((row) => row.key === key || row.key === durableRoot),
            ).toBe(false);
            const previousStateDir = process.env.OPENCLAW_STATE_DIR;
            process.env.OPENCLAW_STATE_DIR = `${state.env.OPENCLAW_STATE_DIR}-moved`;
            try {
              await restoreSessionColdTranscript({
                agentId: actor.agentId,
                storePath: actor.path,
                sessionKey: key,
                sessionId: "prepared-row",
              });
              expect(
                projection
                  .findBySessionId({ sessionId: "prepared-row", federated: true })
                  .map((row) => row.key),
              ).toEqual([key]);
              expect(
                projection.capture({ agentId: actor.agentId, key, storePath: actor.path })?.entry
                  ?.sessionId,
              ).toBe("prepared-row");
            } finally {
              if (previousStateDir === undefined) {
                delete process.env.OPENCLAW_STATE_DIR;
              } else {
                process.env.OPENCLAW_STATE_DIR = previousStateDir;
              }
            }
            expect(
              await readSqliteSessionArchivePruning({
                agentId: actor.agentId,
                path: actor.path,
                env: state.env,
              }),
            ).toBeNull();
            await expect(
              withSqliteSessionPageReclamation(
                { agentId: actor.agentId, path: actor.path, env: state.env },
                async () => undefined,
              ),
            ).rejects.toThrow("no disk pages or archives");
            expect(statements.queries).toEqual([]);
          } finally {
            statements.restore();
          }
          const beforeCleanup = presentations;
          const prepareRows = incognitoReads.withBoundIncognitoSessionRows;
          const cleanupPlacement = vi
            .spyOn(incognitoReads, "withBoundIncognitoSessionRows")
            .mockImplementationOnce(async <T>(...args: Parameters<typeof prepareRows<T>>) => {
              const result = await prepareRows(...args);
              assert(placement);
              placement = await placements.fail({
                sessionId: "prepared-row",
                expectedGeneration: placement.generation,
                recoveryError: "Synthetic placement cleanup change",
              });
              reportPlacementTransition(undefined, placement);
              return result;
            });
          try {
            await expect.soft(describe([key])).rejects.toThrow("changed during cleanup");
            expect(presentations).toBe(beforeCleanup + 1);
          } finally {
            cleanupPlacement.mockRestore();
          }
        });
      } finally {
        placementGap.mockRestore();
        childLookup.mockRestore();
        projection.dispose();
      }
      for (const change of ["abort", "config", "dispose"] as const) {
        let currentConfig = cfg;
        const work = new AsyncWorkScope();
        const readProjection = await createSessionRowProjection({
          cfg,
          getConfig: () => currentConfig,
        });
        const prepareRows = incognitoReads.withBoundIncognitoSessionRows;
        const cleanup = vi
          .spyOn(incognitoReads, "withBoundIncognitoSessionRows")
          .mockImplementationOnce(async <T>(...args: Parameters<typeof prepareRows<T>>) => {
            const result = await prepareRows(...args);
            if (change === "abort") {
              work.beginClose(new Error("Caller retired during cleanup"));
            } else if (change === "config") {
              currentConfig = { ...cfg };
              sessionChanges.emit({ all: true, scope: "config-presentation" });
            } else {
              readProjection.dispose();
            }
            return result;
          });
        const consume = vi.fn(() => "private result");
        try {
          await expect
            .soft(
              work.run(() =>
                withIncognitoSessionBinding({ actor }, () =>
                  withReadySessionRows(
                    readProjection,
                    () => [{ agentId: actor.agentId, key }],
                    consume,
                  ),
                ),
              ),
            )
            .rejects.toThrow();
          expect(consume).toHaveBeenCalledTimes(1);
        } finally {
          cleanup.mockRestore();
          readProjection.dispose();
          await work.drain();
        }
      }
      const original = actor.acp.prepareEntryRead.bind(actor.acp);
      const gap = vi.spyOn(actor.acp, "prepareEntryRead").mockImplementationOnce(async (params) => {
        const prepared = await original(params);
        await actor.sessions.create(authority, {
          sessionKey: "agent:main:dashboard:incognito-late-child",
          entry: { sessionId: "late-child", updatedAt: Date.now(), parentSessionKey: key },
        });
        return prepared;
      });
      try {
        await expect(
          withIncognitoSessionRow({ actor, authority, cfg, env: state.env, key }, () => {
            throw new Error("stale private row disclosed");
          }),
        ).rejects.toThrow("snapshot changed");
      } finally {
        gap.mockRestore();
      }
      const acquireDurable = sessionStoreLookup.withGatewaySessionStoreTarget;
      let retiringRelated: Promise<void> | undefined;
      const relatedGap = vi
        .spyOn(sessionStoreLookup, "withGatewaySessionStoreTarget")
        .mockImplementationOnce((params, consume) => {
          retiringRelated = other.close();
          return acquireDurable(params, consume);
        });
      const consumeRelated = vi.fn();
      try {
        await expect(
          withIncognitoSessionRow({ actor, authority, cfg, env: state.env, key }, consumeRelated),
        ).rejects.toThrow();
        expect(consumeRelated).not.toHaveBeenCalled();
      } finally {
        relatedGap.mockRestore();
        await retiringRelated;
      }
      for (const ending of ["release", "close"] as const) {
        const borrowed: IncognitoAgentDatabaseExecution | undefined =
          await captureOpenClawAgentDatabaseExecution({
            kind: "ephemeral",
            agentId: actor.agentId,
            env: state.env,
            authority,
            existingOnly: true,
          });
        assert(borrowed);
        const prepare = borrowed.acp.prepareEntryRead.bind(borrowed.acp);
        let retiring: Promise<void> | undefined;
        const retire = vi
          .spyOn(borrowed.acp, "prepareEntryRead")
          .mockImplementationOnce(async (params) => {
            const prepared = await prepare(params);
            retiring = ending === "release" ? borrowed.release() : borrowed.close();
            return prepared;
          });
        const consume = vi.fn();
        try {
          await expect(
            withIncognitoSessionRow(
              { actor: borrowed, authority, cfg, env: state.env, key },
              consume,
            ),
          ).rejects.toThrow();
          expect(consume).not.toHaveBeenCalled();
        } finally {
          retire.mockRestore();
          await retiring;
          await borrowed.release();
        }
      }
      await actor.close();
    } finally {
      await resetSubagentRegistryForTests({ persist: false });
      await other.close();
      await actor.close();
    }
  });
});
