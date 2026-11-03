import assert from "node:assert/strict";
import { afterEach, expect, it } from "vitest";
import { awaitGateBeforeSettlement, withinTest } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntrySync,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { memorySessionActorOwners } from "../config/sessions/session-actor-memory-owner.js";
import { captureSessionActorStorageOwner } from "../config/sessions/session-actor-storage-binding.js";
import { readGatewayLockProcessNamespace } from "../infra/gateway-lock-payload.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "./session-create-service.types.js";

function createSession(
  params: Omit<Parameters<typeof createGatewaySession>[0], "commandSource" | "operatorRoleActor">,
) {
  return createGatewaySession({
    ...params,
    commandSource: "test",
    operatorRoleActor: { kind: "system" },
  });
}

type WithCommit = PreparedGatewaySessionLifecycle["withCommit"];
const prepare = (withCommit: WithCommit) => async () => ({
  ok: true as const,
  value: { withCommit },
});
const labelConflict = (label: string) => ({
  ok: false,
  error: { code: "INVALID_REQUEST", message: `label already in use: ${label}` },
});

afterEach(() => memorySessionActorOwners.reset());
it.each(["durable", "incognito", "cross-agent", "shared"])(
  "does not retain a fork that loses its label claim in %s storage",
  (storage) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const incognito = storage === "incognito";
      const childAgent = storage === "cross-agent" || storage === "shared" ? "other" : "main";
      const storePath = storage === "shared" ? state.statePath("shared.sqlite") : undefined;
      const cfg = {
        agents: { ownership: "explicit" as const, entries: { main: {}, other: {} } },
        session: { store: storePath },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const common = { cfg, incognito };
      const parentKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}fork-parent`;
      let childKey = `agent:${childAgent}:dashboard:${incognito ? "incognito-" : ""}fork-loser`;
      const winnerKey = childKey.replace("fork-loser", "winner");
      const parent = await createSession({ ...common, key: parentKey });
      assert(parent.ok);
      const parentScope = { sessionKey: parentKey, sessionId: parent.entry.sessionId, storePath };
      await appendTranscriptMessage(parentScope, {
        message: { role: "user", content: "Preserve this parent history." },
      });
      const parentEvents = await loadTranscriptEvents(parentScope);
      const memory = incognito
        ? captureSessionActorStorageOwner(
            { sessionKey: childKey, agentId: childAgent },
            { assertCurrent() {}, authorize() {} },
          )
        : undefined;
      const database = incognito
        ? undefined
        : openOpenClawAgentDatabase(
            toDatabaseOptions(
              resolveSqliteScope({ sessionKey: childKey, agentId: childAgent, storePath }),
            ),
          );
      const transcriptIds = () =>
        memory
          ? (memory.owner?.listSessions(memory.authority) ?? [])
              .flatMap((row) => (row.entry ? [{ session_id: row.entry.sessionId }] : []))
              .toSorted((a, b) => a.session_id.localeCompare(b.session_id))
          : database!.db
              .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id")
              .all();
      const beforeIds = transcriptIds();
      const entered = createDeferredCore();
      const proceed = createDeferredCore();
      let phase = "";
      let forkPrepared = false;
      const withCommit: WithCommit = async (run) => {
        if (phase === "writerAdmission" || phase === "commit" || (incognito && forkPrepared)) {
          entered.resolve();
          await proceed.promise;
        }
        const result = await run(() => {});
        forkPrepared = true;
        return result;
      };
      const loser = createSession({
        ...common,
        agentId: childAgent,
        key: incognito ? undefined : childKey,
        parentSessionKey: parentKey,
        fork: true,
        label: "Contended",
        onPhase: (value) => {
          phase = value;
        },
        prepareLifecycle: async (target) => {
          childKey = target.key;
          return { ok: true, value: { withCommit } };
        },
      });
      let winner: Awaited<ReturnType<typeof createGatewaySession>>;
      try {
        await awaitGateBeforeSettlement(entered.promise, loser, "Fork missed commit barrier");
        winner = await createSession({ ...common, key: winnerKey, label: "Contended" });
      } finally {
        proceed.resolve();
      }
      expect(await loser).toMatchObject(labelConflict("Contended"));
      assert(winner.ok);
      if (memory) {
        expect(memory.owner?.readSession(childKey, memory.authority)).toBeUndefined();
      } else {
        const sql = (query: string) => database!.db.prepare(query);
        expect({
          node: sql("SELECT session_key FROM session_nodes WHERE session_key = ?").get(childKey),
          windows: sql("SELECT session_id FROM session_windows WHERE session_key = ?").all(
            childKey,
          ),
        }).toEqual({ node: undefined, windows: [] });
      }
      expect(transcriptIds()).toEqual(
        [...beforeIds, { session_id: winner.entry.sessionId }].toSorted((a, b) =>
          String(a.session_id).localeCompare(String(b.session_id)),
        ),
      );
      expect(await loadTranscriptEvents(parentScope)).toEqual(parentEvents);
      expect(loadSessionEntry({ sessionKey: winnerKey, storePath })?.label).toBe("Contended");
    }),
);

it.for(["durable", "incognito", "shared"])(
  "reserves concurrent explicit labels atomically in %s storage",
  (storage, { signal }) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const incognito = storage === "incognito";
      const storePath = storage === "shared" ? state.statePath("shared.sqlite") : undefined;
      const cfg = { agents: { entries: { main: {}, other: {} } }, session: { store: storePath } };
      setRuntimeConfigSnapshot(cfg);
      const prepared = createDeferredCore();
      let preparing = 0;
      const keys = ["first", "second"].map(
        (name, index) =>
          `agent:${storage === "shared" && index === 1 ? "other" : "main"}:dashboard:${incognito ? "incognito-" : ""}${name}`,
      );
      const owner = acquireGatewayStateOwner({
        databasePath: resolveOpenClawStateSqlitePath(),
        payload: {
          pid: process.pid,
          processNamespace: readGatewayLockProcessNamespace(),
          createdAt: new Date().toISOString(),
          configPath: state.configPath,
          stateDir: state.stateDir,
          role: "gateway",
        },
      });
      const creations = keys.map((key) => {
        let joined = false;
        const withCommit: WithCommit = async (run) => {
          if (!joined) {
            joined = true;
            if (++preparing === 2) {
              prepared.resolve();
            }
            await prepared.promise;
          }
          return run(() => {});
        };
        return createSession({
          cfg,
          key,
          incognito,
          label: " Shared label ",
          displayName: "Non-unique native title",
          prepareLifecycle: prepare(withCommit),
        });
      });
      try {
        const outcomes = await withinTest(Promise.all(creations), signal);
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject(
          labelConflict("Shared label"),
        );
        expect(outcomes.find((outcome) => outcome.ok)).toMatchObject({
          entry: { label: "Shared label", displayName: "Non-unique native title" },
        });
        for (const [index, key] of keys.entries()) {
          const stored = loadSessionEntry({ sessionKey: key, storePath });
          expect(stored?.label).toBe(outcomes[index]?.ok ? "Shared label" : undefined);
        }
      } finally {
        prepared.resolve();
        await Promise.allSettled(creations);
        owner.release();
      }
    }),
);

it("rejects a label claimed by a canonical write after creation preparation", () =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const siblingKey = "agent:main:sibling";
    const sibling = await createSession({ cfg: {}, key: siblingKey, label: "Old label" });
    assert(sibling.ok);
    const database = openOpenClawAgentDatabase({ agentId: "main" });
    const withCommit: WithCommit = async (run) => {
      replaceSessionEntrySync(
        { agentId: "main", sessionKey: siblingKey },
        { ...sibling.entry, label: "Claimed" },
      );
      return run(() => {});
    };
    await expect(
      createSession({
        cfg: {},
        key: "agent:main:contender",
        label: "Claimed",
        prepareLifecycle: prepare(withCommit),
      }),
    ).resolves.toMatchObject(labelConflict("Claimed"));
    expect(
      database.db
        .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
        .get("agent:main:contender"),
    ).toBeUndefined();
  }));

it.each([
  { kind: "trimmed", title: "  Native title  ", expected: "Native title" },
  { kind: "blank", title: " \n\t ", expected: undefined },
  {
    kind: "split surrogate",
    title: ` ${"界".repeat(499)}${"🦞".repeat(300)} `,
    expected: "界".repeat(499),
  },
  { kind: "whole surrogates", title: "🦞".repeat(300), expected: "🦞".repeat(250) },
])("bounds a create-only $kind title snapshot", ({ title, expected }) =>
  withOpenClawTestState({ label: "create-display-title" }, async () => {
    const create = (key: string) => createSession({ cfg: {}, key, displayName: title });
    const first = await create("agent:main:title-first");
    const second = await create("agent:main:title-second");
    assert(first.ok && second.ok, "Display titles must not reject session creation");
    for (const { entry } of [first, second]) {
      expect([entry.displayName, entry.label]).toEqual([expected, undefined]);
    }
    expect(first.entry.sessionId).not.toBe(second.entry.sessionId);

    const repeated = await createSession({
      cfg: {},
      key: first.key,
      displayName: "Do not overwrite or backfill existing rows",
    });
    assert(repeated.ok);
    expect([repeated.entry.sessionId, repeated.entry.displayName]).toEqual([
      first.entry.sessionId,
      expected,
    ]);
  }),
);
