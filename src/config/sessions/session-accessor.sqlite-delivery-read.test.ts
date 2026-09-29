import { expect, it } from "vitest";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { loadExactSessionEntryCandidatesReadOnlyBatch } from "./session-accessor.sqlite-exact-read.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";

it("preserves delivery JSON semantics, retained windows, and invalid-row failures", async () => {
  await withOpenClawTestState({ label: "narrow-delivery" }, async (state) => {
    const scope = { agentId: "main", env: state.env };
    const delivery = normalizeSessionDeliveryState({
      context: {
        channel: "matrix",
        to: "!Opaque:example.org",
        accountId: "work",
        threadId: "Topic",
      },
    });
    const entry = { sessionId: "source", updatedAt: 1, delivery, groupId: "!Opaque:example.org" };
    const json = JSON.stringify(entry);
    const cases = [
      { name: "ordinary", json },
      {
        name: "duplicate",
        json: json
          .replace('"sessionId":"source"', '"sessionId":"discarded","sessionId":"source"')
          .replace('"delivery":', '"delivery":null,"delivery":'),
      },
      {
        name: "deep",
        json: json.slice(0, -1) + ',"unused":' + "[".repeat(1100) + "0" + "]".repeat(1100) + "}",
      },
      { name: "null", json: JSON.stringify({ ...entry, delivery: null, groupId: false }) },
      { name: "escaped", json: JSON.stringify({ ...entry, groupId: "opaque-\ud800" }) },
      { name: "absent", json: '{"sessionId":"source","updatedAt":1}' },
    ];
    const database = openOpenClawAgentDatabase(scope);
    for (const item of cases) {
      const sessionKey = `agent:main:${item.name}`;
      replaceSessionEntrySync({ ...scope, sessionKey }, entry);
    }
    const retained = "agent:main:retained";
    runOpenClawAgentWriteTransaction((db) => {
      ensureTranscriptSessionRoot(db, { ...scope, sessionKey: retained, sessionId: "retained" }, 1);
    }, scope);
    const keys = [...cases.map(({ name }) => `agent:main:${name}`), retained, "agent:main:missing"];
    const read = (projection: "list" | "delivery") =>
      loadExactSessionEntryCandidatesReadOnlyBatch(
        keys.map((key) => ({ ...scope, sessionKeys: [key], projection })),
      );
    expect(read("delivery").every((result) => result.ok)).toBe(true);
    // Admitted readers preserve raw metadata parsing; cold admission still rejects uncertified rows.
    for (const [index, item] of cases.entries()) {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(item.json, keys[index]!);
    }
    expect(read("delivery")).toEqual([
      ...cases.map(({ json: stored }, index) => {
        const { sessionId, updatedAt, delivery: route, groupId } = JSON.parse(stored);
        return {
          ok: true,
          value: [
            {
              sessionKey: keys[index],
              entry: {
                sessionId,
                updatedAt,
                ...(route !== undefined ? { delivery: route } : {}),
                ...(groupId !== undefined ? { groupId } : {}),
              },
            },
          ],
        };
      }),
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
    for (const broken of [
      json + "\u0000tail",
      '{"unrelated":true}',
      json.replace('"updatedAt":1', '"updatedAt":2'),
    ]) {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(broken, keys[0]!);
      expect(read("delivery").map((r) => r.ok)).toEqual(read("list").map((r) => r.ok));
      expect(read("delivery")[0]).toMatchObject({
        ok: false,
        error: { code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" },
      });
    }
  });
});
