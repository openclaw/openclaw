import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import {
  createTranscriptReadMeter,
  readTranscriptPageInDatabase,
} from "./session-transcript-page-read.kernel.js";
import type { TranscriptPageReadRequest } from "./session-transcript-page-read.types.js";
import { prepareTranscriptPayload } from "./transcript-payload.js";

const limits = { limit: 2, maxScannedEntries: 1_000, maxMaterializedBytes: 16 * 1024 * 1024 };
const events = [
  { type: "session", id: "page-session", version: 3 },
  { type: "message", id: "user-entry", message: { role: "user", content: "雪🦞" } },
  { type: "message", id: "reply-entry", message: { role: "assistant", content: "hello" } },
];

async function withFixture(
  mutate: (database: DatabaseSync) => void,
  run: (
    read: (
      patch?: Partial<TranscriptPageReadRequest>,
    ) => ReturnType<typeof readTranscriptPageInDatabase>,
  ) => void,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async ({ env }) => {
    const writer = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-read",
      sessionId: "page-session",
      path: writer.path,
    };
    writeSessionEntry(writer, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "revision-1",
    });
    await replaceTranscriptEvents({ ...scope, storePath: writer.path, env }, events);
    mutate(writer.db);
    await closeOpenClawAgentDatabaseByPathAsync(writer.path, writer.agentId);
    const opened = withOpenClawAgentDatabaseReadOnly(
      (reader) =>
        run((patch) => {
          const request = { scope, expectedLifecycleRevision: "revision-1", limits, ...patch };
          const observed = trackSqliteStatementExecutions(reader.db, ["source"], (query) =>
            /^select .* as "value"/i.test(query) ? "source" : null,
          );
          try {
            const result = readTranscriptPageInDatabase(
              reader,
              request,
              createTranscriptReadMeter(request.limits),
            );
            expect(result.budget.scannedEntries).toBe(observed.rowCounts.source);
            expect(result.budget.materializedBytes).toBe(observed.textBytes.source);
            return result;
          } finally {
            observed.restore();
          }
        }),
      { agentId: "main", path: writer.path, env },
    );
    expect(opened.found).toBe(true);
  });
}

it("distinguishes an empty hot transcript, a missing node, and stale lifecycle without private entry reads", async () => {
  await withFixture(
    (db) => db.exec("DELETE FROM transcript_events"),
    (read) => {
      expect(read()).toMatchObject({ ok: true, value: { records: [] }, budget: { final: true } });
      expect(read({ expectedLifecycleRevision: "old-revision" })).toMatchObject({
        ok: false,
        error: "stale_session",
      });
    },
  );
  await withFixture(
    (db) => db.exec("DELETE FROM session_nodes"),
    (read) => {
      expect(read()).toMatchObject({ ok: false, error: "missing", budget: { final: true } });
    },
  );
});

it("refuses cold history without decoding or modifying its marker", async () => {
  await withFixture(
    (db) =>
      db
        .prepare(
          "INSERT INTO session_transcript_cold_archives (session_id, generation, archive_name, archive_sha256, event_count, raw_bytes, archive_bytes, last_seq, archived_at, storage) VALUES (?, 'cold', 'synthetic', ?, 3, 0, 0, 2, 1, 'file')",
        )
        .run("page-session", "0".repeat(64)),
    (read) => {
      expect(read()).toMatchObject({ ok: false, error: "unsupported", budget: { final: true } });
    },
  );
});

it.each(["text", "compressed"])(
  "refuses an oversized %s event before payload acquisition, without skipping it",
  async (storage) => {
    const codec = resolveZstdCodec()!;
    const decode = vi.spyOn(codec, "decompress");
    try {
      await withFixture(
        (db) => {
          const json = JSON.stringify({
            ...events[1],
            message: { role: "user", content: "x".repeat(4096) },
          });
          const payload = prepareTranscriptPayload(db, json);
          db.prepare(
            "UPDATE transcript_events SET event_json = ?, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = 1",
          ).run(
            storage === "text" ? "x".repeat(limits.maxMaterializedBytes + 1) : null,
            storage === "compressed" ? payload.event_zstd : null,
            // The TEXT case proves stale recorded lengths cannot bypass admission.
            storage === "text" ? 1 : payload.event_utf8_bytes,
            storage === "text" ? null : payload.navigation_json,
            "page-session",
          );
          decode.mockClear();
        },
        (read) => {
          // Compressed rows have an existing 4 MiB schema ceiling; exercise a
          // smaller requested operation budget using valid stored compressed data.
          const pageLimits =
            storage === "compressed" ? { ...limits, maxMaterializedBytes: 1024 } : limits;
          const first = read({ limits: pageLimits });
          expect(first).toMatchObject({
            ok: true,
            value: { records: [{ storedEntryId: "page-session" }] },
            budget: { exhausted: true, final: true },
          });
          if (!first.ok) {
            throw new Error(first.error);
          }
          expect(first.value.records).toHaveLength(1);
          expect(read({ position: first.value.nextPosition, limits: pageLimits })).toMatchObject({
            ok: false,
            error: "resource_limit",
            budget: { exhausted: true, final: true },
          });
          expect(decode).not.toHaveBeenCalled();
        },
      );
    } finally {
      decode.mockRestore();
    }
  },
);

it("counts decoded Unicode source and repeated metadata using independent native observations", async () => {
  const codec = resolveZstdCodec()!;
  const json = JSON.stringify({
    ...events[1],
    message: { role: "user", content: "雪🦞".repeat(2000) },
  });
  const decodedSizes: number[] = [];
  const decompress = codec.decompress.bind(codec);
  const spy = vi.spyOn(codec, "decompress").mockImplementation((...args) => {
    const value = decompress(...args);
    decodedSizes.push(value.byteLength);
    return value;
  });
  try {
    await withFixture(
      (db) => {
        const payload = prepareTranscriptPayload(db, json);
        expect(payload.event_zstd).not.toBeNull();
        db.prepare(
          "UPDATE transcript_events SET event_json = NULL, event_zstd = ?, event_utf8_bytes = ?, navigation_json = ? WHERE session_id = ? AND seq = 1",
        ).run(
          payload.event_zstd,
          payload.event_utf8_bytes,
          payload.navigation_json,
          "page-session",
        );
        decodedSizes.length = 0;
      },
      (read) => {
        const first = read();
        const second = read();
        expect(first.ok).toBe(true);
        expect(second.budget).toEqual(first.budget);
        expect(decodedSizes).toEqual([Buffer.byteLength(json), Buffer.byteLength(json)]);
        expect(first.budget.materializedBytes).toBeGreaterThan(decodedSizes[0]);
      },
    );
  } finally {
    spy.mockRestore();
  }
});

it("charges malformed JSON before returning only a closed failure", async () => {
  await withFixture(
    (db) =>
      db
        .prepare("UPDATE transcript_events SET event_json = ?, event_zstd = NULL WHERE seq = 0")
        .run('{"secret":"synthetic"'),
    (read) => {
      const result = read();
      expect(result).toMatchObject({ ok: false, error: "read_failed", budget: { final: true } });
      expect(JSON.stringify(result)).not.toContain("synthetic");
    },
  );
});

it("refuses the next inspection at a small aggregate bound rather than returning an unmetered row", async () => {
  await withFixture(
    () => {},
    (read) => {
      const result = read({ limits: { ...limits, maxScannedEntries: 1 } });
      expect(result).toEqual({
        ok: false,
        error: "resource_limit",
        budget: {
          scannedEntries: 1,
          materializedBytes: Buffer.byteLength('"UTF-8"'),
          exhausted: true,
          final: true,
        },
      });
    },
  );
});

it("pages an existing transcript on a read-only handle with observed aggregate accounting", async () => {
  await withOpenClawTestState({ label: "page-read-kernel" }, async ({ env }) => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env });
    const scope = {
      agentId: "main",
      sessionKey: "agent:main:page-read",
      sessionId: "page-session",
      path: database.path,
    };
    writeSessionEntry(database, scope.sessionKey, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      lifecycleRevision: "revision-1",
    });
    await replaceTranscriptEvents({ ...scope, storePath: database.path, env }, events);
    await closeOpenClawAgentDatabaseByPathAsync(database.path, database.agentId);
    const read = withOpenClawAgentDatabaseReadOnly(
      (reader) => {
        expect(reader).toBeDefined();
        if (!reader) {
          throw new Error("fixture reader missing");
        }
        const observed = trackSqliteStatementExecutions(reader.db, ["source"], (sql) =>
          /^select .* as "value"/i.test(sql) ? "source" : null,
        );
        const result = readTranscriptPageInDatabase(
          reader,
          { scope, expectedLifecycleRevision: "revision-1", limits },
          createTranscriptReadMeter(limits),
        );
        try {
          expect(result.budget.scannedEntries).toBe(observed.rowCounts.source);
          expect(result.budget.materializedBytes).toBe(observed.textBytes.source);
        } finally {
          observed.restore();
        }
        return result;
      },
      { agentId: "main", path: database.path, env },
    );
    expect(read.found).toBe(true);
    if (!read.found) {
      throw new Error(read.reason);
    }
    const result = read.value;
    expect(result).toMatchObject({
      ok: true,
      value: {
        records: [
          { storedEntryId: "page-session", event: events[0] },
          { storedEntryId: "user-entry", event: events[1] },
        ],
      },
      budget: { final: true, exhausted: false },
    });
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.budget.scannedEntries).toBeGreaterThan(2);
    expect(result.budget.materializedBytes).toBeGreaterThan(
      Buffer.byteLength(JSON.stringify(events[0]) + JSON.stringify(events[1])),
    );
    expect(result.value.nextPosition).toBeDefined();
    expect(result.value.records[0].afterPosition).toEqual(result.value.records[1].beforePosition);
  });
});

it("does not claim final accounting while a native reservation is unobserved", () => {
  const meter = createTranscriptReadMeter(limits);
  const reservation = meter.reserve(1, 100)!;
  expect(meter.snapshot(true).final).toBe(false);
  reservation.observe(0, 0);
  expect(meter.snapshot(true).final).toBe(true);
  expect(() => reservation.observe(0, 0)).toThrow();
});

it("caps returned records independently of the source inspection allowance", async () => {
  await withFixture(
    (db) => {
      const insert = db.prepare(
        "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, 1)",
      );
      for (let index = 3; index < 55; index++) {
        insert.run(
          "page-session",
          index,
          JSON.stringify({
            type: "message",
            id: `entry-${index}`,
            message: { role: "user", content: "fixture" },
          }),
        );
      }
    },
    (read) => {
      const first = read({ limits: { ...limits, limit: 50 } });
      expect(first.ok).toBe(true);
      if (!first.ok) {
        throw new Error(first.error);
      }
      expect(first.value.records).toHaveLength(50);
      expect(first.budget.exhausted).toBe(false);
      const second = read({ limits: { ...limits, limit: 50 }, position: first.value.nextPosition });
      expect(second.ok).toBe(true);
      if (!second.ok) {
        throw new Error(second.error);
      }
      expect(second.value.records).toHaveLength(5);
      expect(second.value.nextPosition).toBeUndefined();
      expect(first.value.records.at(-1)!.afterPosition).toEqual(
        second.value.records[0].beforePosition,
      );
    },
  );
});

it("retains consumed source allowance across subreads and releases unused reservations only", () => {
  const meter = createTranscriptReadMeter(limits);
  for (let index = 0; index < 1_000; index++) {
    const reservation = meter.reserve(1, 100);
    expect(reservation).toBeDefined();
    reservation!.observe(1, 20);
  }
  expect(meter.reserve(1, 1)).toBeUndefined();
  expect(meter.snapshot(true)).toEqual({
    scannedEntries: 1_000,
    materializedBytes: 20_000,
    exhausted: true,
    final: true,
  });
});

it.each([0, -1, 51, Number.NaN, Number.POSITIVE_INFINITY, 1.5])(
  "refuses invalid page limit %s before any source work",
  (limit) => {
    expect(() => createTranscriptReadMeter({ ...limits, limit })).toThrow();
  },
);

it.each(["maxScannedEntries", "maxMaterializedBytes"] as const)(
  "validates all %s bounds",
  (key) => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 0.5, limits[key] + 1]) {
      expect(() => createTranscriptReadMeter({ ...limits, [key]: value })).toThrow();
    }
  },
);
