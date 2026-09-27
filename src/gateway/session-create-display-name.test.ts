import { describe, expect, it } from "vitest";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import {
  resolveSqliteScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createGatewaySession } from "./session-create-service.js";
import type { PreparedGatewaySessionLifecycle } from "./session-create-service.types.js";

describe("session creation display titles", () => {
  it.each(["durable", "incognito", "cross-agent", "shared"])(
    "does not retain a fork that loses its label claim in %s storage",
    async (storage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const incognito = storage === "incognito";
        const childAgent = storage === "cross-agent" || storage === "shared" ? "other" : "main";
        const storePath = storage === "shared" ? state.statePath("shared.sqlite") : undefined;
        const cfg = {
          agents: { ownership: "explicit" as const, entries: { main: {}, other: {} } },
          session: { store: storePath },
        };
        await state.writeConfig(cfg);
        const common = {
          cfg,
          incognito,
          commandSource: "test",
          operatorRoleActor: { kind: "system" as const },
        };
        const parentKey = `agent:main:dashboard:${incognito ? "incognito-" : ""}fork-parent`;
        let childKey = `agent:${childAgent}:dashboard:${incognito ? "incognito-" : ""}fork-loser`;
        const winnerKey = childKey.replace("fork-loser", "winner");
        const parent = await createGatewaySession({ ...common, key: parentKey });
        if (!parent.ok) {
          throw new Error(parent.error.message);
        }
        const parentScope = { sessionKey: parentKey, sessionId: parent.entry.sessionId, storePath };
        await appendTranscriptMessage(parentScope, {
          message: { role: "user", content: "Preserve this parent history." },
        });
        const parentEvents = await loadTranscriptEvents(parentScope);
        const database = openOpenClawAgentDatabase(
          toDatabaseOptions(
            resolveSqliteScope({ sessionKey: childKey, agentId: childAgent, storePath }),
          ),
        );
        const transcriptIds = () =>
          database.db
            .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id")
            .all();
        const beforeIds = transcriptIds();
        const entered = createDeferredCore();
        const proceed = createDeferredCore();
        let phase = "";
        const withCommit: PreparedGatewaySessionLifecycle["withCommit"] = async (run) => {
          if (phase === "writerAdmission" || phase === "commit") {
            entered.resolve();
            await proceed.promise;
          }
          return run(() => {});
        };
        const loser = createGatewaySession({
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
          await Promise.race([
            entered.promise,
            loser.then((result) => {
              throw new Error(`Fork did not reach commit barrier: ${JSON.stringify(result)}`);
            }),
          ]);
          winner = await createGatewaySession({ ...common, key: winnerKey, label: "Contended" });
        } finally {
          proceed.resolve();
        }
        expect(await loser).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message: "label already in use: Contended" },
        });
        if (!winner.ok) {
          throw new Error(winner.error.message);
        }
        expect(
          database.db
            .prepare("SELECT session_key FROM session_nodes WHERE session_key = ?")
            .get(childKey),
        ).toBeUndefined();
        expect(
          database.db
            .prepare("SELECT session_id FROM session_windows WHERE session_key = ?")
            .all(childKey),
        ).toEqual([]);
        expect(transcriptIds()).toEqual(
          [...beforeIds, { session_id: winner.entry.sessionId }].toSorted((a, b) =>
            String(a.session_id).localeCompare(String(b.session_id)),
          ),
        );
        expect(await loadTranscriptEvents(parentScope)).toEqual(parentEvents);
        expect(loadSessionEntry({ sessionKey: winnerKey, storePath })?.label).toBe("Contended");
      });
    },
  );

  it.each(["durable", "incognito", "shared"])(
    "reserves concurrent explicit labels atomically in %s storage",
    async (storage) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const incognito = storage === "incognito";
        const storePath = storage === "shared" ? state.statePath("shared.sqlite") : undefined;
        const cfg = { agents: { entries: { main: {}, other: {} } }, session: { store: storePath } };
        const prepared = createDeferredCore();
        let preparing = 0;
        const keys = ["first", "second"].map(
          (name, index) =>
            `agent:${storage === "shared" && index === 1 ? "other" : "main"}:dashboard:${incognito ? "incognito-" : ""}${name}`,
        );
        const outcomes = await Promise.all(
          keys.map((key) => {
            let joined = false;
            const withCommit: PreparedGatewaySessionLifecycle["withCommit"] = async (run) => {
              if (!joined) {
                joined = true;
                if (++preparing === 2) {
                  prepared.resolve();
                }
                await prepared.promise;
              }
              return run(() => {});
            };
            return createGatewaySession({
              cfg,
              key,
              incognito,
              label: " Shared label ",
              commandSource: "test",
              operatorRoleActor: { kind: "system" },
              prepareLifecycle: async () => ({ ok: true, value: { withCommit } }),
            });
          }),
        );
        expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
        expect(outcomes.find((outcome) => !outcome.ok)).toMatchObject({
          ok: false,
          error: { code: "INVALID_REQUEST", message: "label already in use: Shared label" },
        });
        for (const [index, key] of keys.entries()) {
          const stored = loadSessionEntry({ sessionKey: key, storePath });
          if (outcomes[index]?.ok) {
            expect(stored?.label).toBe("Shared label");
          } else {
            expect(stored?.label).toBeUndefined();
          }
        }
      });
    },
  );

  it("rejects a label claimed by a raw metadata edit after creation preparation", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const siblingKey = "agent:main:sibling";
      const sibling = await createGatewaySession({
        cfg: {},
        key: siblingKey,
        label: "Old label",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(sibling.ok).toBe(true);
      if (!sibling.ok) {
        throw new Error(sibling.error.message);
      }
      const database = openOpenClawAgentDatabase({ agentId: "main" });
      const withCommit: PreparedGatewaySessionLifecycle["withCommit"] = async (run) => {
        database.db
          .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
          .run(JSON.stringify({ ...sibling.entry, label: "Claimed" }), siblingKey);
        return run(() => {});
      };
      await expect(
        createGatewaySession({
          cfg: {},
          key: "agent:main:contender",
          label: "Claimed",
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
          prepareLifecycle: async () => ({ ok: true, value: { withCommit } }),
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "label already in use: Claimed" },
      });
      expect(loadSessionEntry({ sessionKey: "agent:main:contender" })).toBeUndefined();
    });
  });

  it.each([
    { kind: "trimmed", title: "  Native title  ", expected: "Native title" },
    { kind: "blank", title: " \n\t ", expected: undefined },
    {
      kind: "split surrogate",
      title: ` ${"界".repeat(499)}${"🦞".repeat(300)} `,
      expected: "界".repeat(499),
    },
    { kind: "whole surrogates", title: "🦞".repeat(300), expected: "🦞".repeat(250) },
  ])("bounds a create-only $kind title snapshot", async ({ title, expected }) => {
    await withOpenClawTestState({ label: "create-display-title" }, async () => {
      const first = await createGatewaySession({
        cfg: {},
        key: "agent:main:title-first",
        displayName: title,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      const second = await createGatewaySession({
        cfg: {},
        key: "agent:main:title-second",
        displayName: title,
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      if (!first.ok || !second.ok) {
        throw new Error("Display titles must not reject session creation");
      }
      expect(first.entry.displayName).toBe(expected);
      expect(second.entry.displayName).toBe(expected);
      expect(first.entry.label).toBeUndefined();
      expect(second.entry.label).toBeUndefined();
      expect(first.entry.sessionId).not.toBe(second.entry.sessionId);

      const repeated = await createGatewaySession({
        cfg: {},
        key: first.key,
        displayName: "Do not overwrite or backfill existing rows",
        commandSource: "test",
        operatorRoleActor: { kind: "system" },
      });
      expect(repeated).toMatchObject({
        ok: true,
        entry: { sessionId: first.entry.sessionId },
      });
      if (!repeated.ok) {
        throw new Error(repeated.error.message);
      }
      expect(repeated.entry.displayName).toBe(expected);
    });
  });

  it("preserves explicit labels and still rejects equivalent duplicate labels", async () => {
    await withOpenClawTestState({ label: "create-title-with-label" }, async () => {
      const create = (key: string, label: string) =>
        createGatewaySession({
          cfg: {},
          key,
          label,
          displayName: "Non-unique native title",
          commandSource: "test",
          operatorRoleActor: { kind: "system" },
        });
      const first = await create("agent:main:operator-first", "Operator label");
      expect(first).toMatchObject({
        ok: true,
        entry: { label: "Operator label", displayName: "Non-unique native title" },
      });
      await expect(
        create("agent:main:operator-second", "  Operator label  "),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "INVALID_REQUEST", message: "label already in use: Operator label" },
      });
    });
  });
});
