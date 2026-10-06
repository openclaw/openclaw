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
import type { IncognitoAgentDatabaseExecution } from "../state/openclaw-agent-execution-incognito.js";
import { captureOpenClawAgentDatabaseExecution } from "../state/openclaw-agent-execution.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readResidentSessionRow } from "./session-row-projection-materialize.js";
import { withIncognitoSessionRow } from "./session-row-projection-read.js";
import type { Row } from "./session-row-projection-record.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import { presentSessionRow } from "./session-utils-row.js";
import * as sessionStoreLookup from "./session-utils-store-lookup.js";

// Two retained private actors plus shared-state reads need three broker slots.
vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  availableParallelism: () => 24,
}));

it("materializes actor-prepared private entries and lineage without host SQLite", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const cfg = { agents: { entries: { main: {}, work: {} } } };
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
        entry: { sessionId: "registry-child", updatedAt: Date.now(), status: "running" },
      });
      const durableChild = "agent:work:subagent:durable-registry-child";
      replaceSessionEntrySync(
        { agentId: "work", sessionKey: durableChild, env: state.env },
        {
          sessionId: "durable-registry-child",
          updatedAt: Date.now(),
          status: "running",
        },
      );
      for (const registeredChild of [registryChild, durableChild]) {
        seedSubagentRunForReadTest({
          runId: registeredChild,
          childSessionKey: registeredChild,
          requesterSessionKey: key,
          controllerSessionKey: key,
          task: "Synthetic child",
          cleanup: "keep",
          createdAt: Date.now(),
          startedAt: Date.now(),
        });
        subagentRuns.commitOwnership(subagentRuns.get(registeredChild)!);
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
      const deliveryBorrow = await captureOpenClawAgentDatabaseExecution({
        kind: "ephemeral",
        agentId: actor.agentId,
        env: state.env,
        authority,
        existingOnly: true,
      });
      assert(deliveryBorrow);
      let retireAtDelivery = false;
      let retiringDelivery: Promise<void> | undefined;
      try {
        await expect(
          withIncognitoSessionRow(
            {
              actor: deliveryBorrow,
              authority: {
                assertCurrent() {
                  if (retireAtDelivery) {
                    retiringDelivery ??= deliveryBorrow.release();
                  }
                },
              },
              cfg,
              env: state.env,
              key: parentKey,
            },
            () => {
              queueMicrotask(() => {
                retireAtDelivery = true;
              });
              return "private row result";
            },
          ),
        ).rejects.toThrow("reference is released");
      } finally {
        await retiringDelivery;
        await deliveryBorrow.release();
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
