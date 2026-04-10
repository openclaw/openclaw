// Octopus Orchestrator — EventLogService tests (M1-03 + M1-04 + M1-06)
//
// Covers:
//   - EventLogService.append happy paths (envelope composition, ULID,
//     file persistence, ts defaulting, directory creation)
//   - TypeBox validation rejections (missing fields, bad enum values,
//     empty strings, bad schema_version)
//   - Round-trip for optional causation_id / correlation_id
//   - ULID helper: length, alphabet, monotonicity, same-ms path
//   - resolveEventLogPath env-override behaviour
//   - replay (M1-04): streaming, migration, filter, error paths
//   - tail (M1-06): polling, filter, abort, fromBeginning

import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  existsSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EventEnvelope } from "../wire/events.ts";
import {
  EventLogService,
  generateUlid,
  resolveEventLogPath,
  type AppendInput,
  type EventLogFilter,
  type MigrationFn,
} from "./event-log.ts";

function makeInput(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    schema_version: 1,
    entity_type: "arm",
    entity_id: "arm-abc",
    event_type: "arm.created",
    actor: "head",
    payload: { foo: "bar" },
    ...overrides,
  };
}

describe("EventLogService", () => {
  let tmpDir: string;
  let logPath: string;
  let svc: EventLogService;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "octo-event-log-"));
    logPath = path.join(tmpDir, "octo", "events.jsonl");
    svc = new EventLogService({ path: logPath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("appends a single valid event", async () => {
    const envelope = await svc.append(makeInput());

    expect(envelope.event_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(envelope.schema_version).toBe(1);
    expect(envelope.entity_type).toBe("arm");
    expect(envelope.entity_id).toBe("arm-abc");
    expect(envelope.event_type).toBe("arm.created");
    expect(envelope.actor).toBe("head");
    expect(envelope.payload).toEqual({ foo: "bar" });
    expect(typeof envelope.ts).toBe("string");
    expect(envelope.ts.length).toBeGreaterThan(0);

    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual(envelope);
  });

  it("appends 100 events and produces 100 lines with monotonic ULIDs", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const env = await svc.append(makeInput({ entity_id: `arm-${i}` }));
      ids.push(env.event_id);
    }

    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(100);

    const fileIds = lines.map((l) => {
      const parsed: unknown = JSON.parse(l);
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("event_id" in parsed) ||
        typeof (parsed as { event_id: unknown }).event_id !== "string"
      ) {
        throw new Error("unexpected line shape");
      }
      return (parsed as { event_id: string }).event_id;
    });
    expect(fileIds).toEqual(ids);

    const sorted = ids.toSorted();
    expect(sorted).toEqual(ids);
  });

  it("append rejects an event with missing required fields (actor)", async () => {
    const bad = makeInput() as Partial<AppendInput>;
    delete bad.actor;
    await expect(svc.append(bad as AppendInput)).rejects.toThrow(/actor/);
  });

  it("append rejects an event with an empty entity_id", async () => {
    await expect(svc.append(makeInput({ entity_id: "" }))).rejects.toThrow(/entity_id/);
  });

  it("append rejects an event with an unknown event_type", async () => {
    await expect(
      svc.append(
        makeInput({
          event_type: "bogus.event" as unknown as AppendInput["event_type"],
        }),
      ),
    ).rejects.toThrow(/event_type/);
  });

  it("append rejects an event with an unknown entity_type", async () => {
    await expect(
      svc.append(
        makeInput({
          entity_type: "widget" as unknown as AppendInput["entity_type"],
        }),
      ),
    ).rejects.toThrow(/entity_type/);
  });

  it("append rejects schema_version: 0", async () => {
    await expect(svc.append(makeInput({ schema_version: 0 }))).rejects.toThrow(/schema_version/);
  });

  it("append generates a fresh ULID per call", async () => {
    const a = await svc.append(makeInput());
    const b = await svc.append(makeInput());
    expect(a.event_id).not.toBe(b.event_id);
  });

  it("append uses ts from input when provided", async () => {
    const ts = "2025-01-02T03:04:05.678Z";
    const env = await svc.append(makeInput({ ts }));
    expect(env.ts).toBe(ts);
  });

  it("append defaults ts to current time when omitted", async () => {
    const before = Date.now();
    const env = await svc.append(makeInput());
    const after = Date.now();
    const parsed = Date.parse(env.ts);
    expect(Number.isFinite(parsed)).toBe(true);
    // Allow a 2-second window around the call.
    expect(parsed).toBeGreaterThanOrEqual(before - 2000);
    expect(parsed).toBeLessThanOrEqual(after + 2000);
  });

  it("append creates the parent directory if missing", async () => {
    const deep = path.join(tmpDir, "a", "b", "c", "events.jsonl");
    const deepSvc = new EventLogService({ path: deep });
    expect(existsSync(path.dirname(deep))).toBe(false);
    await deepSvc.append(makeInput());
    expect(existsSync(deep)).toBe(true);
    const lines = readFileSync(deep, "utf8")
      .split("\n")
      .filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
  });

  it("append preserves causation_id and correlation_id when provided", async () => {
    const env = await svc.append(makeInput({ causation_id: "cause-1", correlation_id: "corr-1" }));
    expect(env.causation_id).toBe("cause-1");
    expect(env.correlation_id).toBe("corr-1");

    const line = readFileSync(logPath, "utf8").split("\n")[0];
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect(parsed.causation_id).toBe("cause-1");
    expect(parsed.correlation_id).toBe("corr-1");
  });

  it("append omits causation_id and correlation_id when not provided", async () => {
    const env = await svc.append(makeInput());
    expect("causation_id" in env).toBe(false);
    expect("correlation_id" in env).toBe(false);

    const line = readFileSync(logPath, "utf8").split("\n")[0];
    const parsed = JSON.parse(line) as Record<string, unknown>;
    expect("causation_id" in parsed).toBe(false);
    expect("correlation_id" in parsed).toBe(false);
  });
});

describe("generateUlid (append-path helper)", () => {
  it("append-path: generateUlid produces 26-character Crockford base32 strings", () => {
    const alphabet = /^[0-9A-HJKMNP-TV-Z]{26}$/;
    for (let i = 0; i < 100; i++) {
      const id = generateUlid();
      expect(id).toHaveLength(26);
      expect(id).toMatch(alphabet);
    }
  });

  it("append-path: generateUlid is monotonic across rapid calls", () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(generateUlid());
    }
    const sorted = ids.toSorted();
    expect(sorted).toEqual(ids);
    // Sanity: all unique.
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("append-path: generateUlid handles same-millisecond calls via random buffer increment", () => {
    const fixedNow = 1_700_000_000_000;
    const a = generateUlid(fixedNow);
    const b = generateUlid(fixedNow);
    const c = generateUlid(fixedNow);
    expect(a.slice(0, 10)).toBe(b.slice(0, 10));
    expect(b.slice(0, 10)).toBe(c.slice(0, 10));
    expect(a < b).toBe(true);
    expect(b < c).toBe(true);
  });
});

describe("resolveEventLogPath (append-path resolver)", () => {
  it("append-path: resolveEventLogPath respects OPENCLAW_STATE_DIR", () => {
    const p = resolveEventLogPath({ OPENCLAW_STATE_DIR: "/tmp/custom-state" });
    expect(p).toBe(path.join("/tmp/custom-state", "octo", "events.jsonl"));
  });

  it("append-path: resolveEventLogPath falls back to ~/.openclaw", () => {
    const p = resolveEventLogPath({});
    expect(p.endsWith(path.join(".openclaw", "octo", "events.jsonl"))).toBe(true);
  });

  it("append-path: resolveEventLogPath treats whitespace-only OPENCLAW_STATE_DIR as unset", () => {
    const p = resolveEventLogPath({ OPENCLAW_STATE_DIR: "   " });
    expect(p.endsWith(path.join(".openclaw", "octo", "events.jsonl"))).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// M1-04 / M1-06 — replay + tail
// ══════════════════════════════════════════════════════════════════════════

async function waitForCollector<T>(
  collector: T[],
  expected: number,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (collector.length < expected) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitForCollector timeout: got ${collector.length}, expected ${expected}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeInputForReplay(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    schema_version: 1,
    entity_type: "arm",
    entity_id: "arm-abc",
    event_type: "arm.created",
    actor: "head",
    payload: { foo: "bar" },
    ...overrides,
  };
}

describe("replay (M1-04)", () => {
  let tmpDir: string;
  let logPath: string;
  let svc: EventLogService;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "octo-event-log-replay-"));
    logPath = path.join(tmpDir, "octo", "events.jsonl");
    svc = new EventLogService({ path: logPath });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("replay on missing event log file returns 0", async () => {
    const collected: EventEnvelope[] = [];
    const count = await svc.replay((e) => {
      collected.push(e);
    });
    expect(count).toBe(0);
    expect(collected).toHaveLength(0);
  });

  it("replay calls handler for each appended event in order", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const env = await svc.append(makeInputForReplay({ entity_id: `arm-${i}` }));
      ids.push(env.event_id);
    }
    const collected: EventEnvelope[] = [];
    const count = await svc.replay((e) => {
      collected.push(e);
    });
    expect(count).toBe(10);
    expect(collected.map((e) => e.event_id)).toEqual(ids);
  });

  it("replay applies migration transforms for older schema_version events", async () => {
    mkdirSync(path.dirname(logPath), { recursive: true });
    // Write a v1 event directly (bypassing append).
    const v1Envelope = {
      event_id: generateUlid(),
      schema_version: 1,
      entity_type: "arm",
      entity_id: "arm-old",
      event_type: "arm.created",
      ts: "2025-01-01T00:00:00.000Z",
      actor: "head",
      payload: { legacy: true },
    };
    writeFileSync(logPath, `${JSON.stringify(v1Envelope)}\n`, "utf8");

    // Append a v2 event via append... but append validates schema_version >=1.
    // Instead write a v2 event directly too.
    const v2Envelope = {
      event_id: generateUlid(),
      schema_version: 2,
      entity_type: "arm",
      entity_id: "arm-new",
      event_type: "arm.created",
      ts: "2025-01-02T00:00:00.000Z",
      actor: "head",
      payload: { upgraded: true, legacy: false },
    };
    appendFileSync(logPath, `${JSON.stringify(v2Envelope)}\n`, "utf8");

    const migration1to2: MigrationFn = (env) => ({
      ...env,
      schema_version: 2,
      payload: { ...env.payload, upgraded: true },
    });

    const collected: EventEnvelope[] = [];
    const count = await svc.replay(
      (e) => {
        collected.push(e);
      },
      {
        migrations: { 1: migration1to2 },
        currentSchemaVersion: 2,
      },
    );
    expect(count).toBe(2);
    expect(collected[0].schema_version).toBe(2);
    expect(collected[0].payload.upgraded).toBe(true);
    expect(collected[1].schema_version).toBe(2);
    expect(collected[1].payload.upgraded).toBe(true);
  });

  it("replay throws when a required migration is missing", async () => {
    mkdirSync(path.dirname(logPath), { recursive: true });
    const v1Envelope = {
      event_id: generateUlid(),
      schema_version: 1,
      entity_type: "arm",
      entity_id: "arm-old",
      event_type: "arm.created",
      ts: "2025-01-01T00:00:00.000Z",
      actor: "head",
      payload: {},
    };
    writeFileSync(logPath, `${JSON.stringify(v1Envelope)}\n`, "utf8");

    await expect(svc.replay(() => {}, { currentSchemaVersion: 2 })).rejects.toThrow(
      /missing migration.*schema_version 1/,
    );
  });

  it("replay throws on a malformed JSON line", async () => {
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, "this is not json\n", "utf8");
    await expect(svc.replay(() => {})).rejects.toThrow(/malformed JSON on line 1/);
  });

  it("replay throws on a JSON line that fails schema validation", async () => {
    mkdirSync(path.dirname(logPath), { recursive: true });
    writeFileSync(logPath, `${JSON.stringify({ schema_version: 1, partial: true })}\n`, "utf8");
    await expect(svc.replay(() => {})).rejects.toThrow(/invalid event on line 1/);
  });

  it("replay applies filter when provided", async () => {
    for (let i = 0; i < 5; i++) {
      await svc.append(makeInputForReplay({ entity_id: `arm-${i}` }));
    }
    for (let i = 0; i < 3; i++) {
      await svc.append(
        makeInputForReplay({
          entity_type: "grip",
          entity_id: `grip-${i}`,
          event_type: "grip.created",
        }),
      );
    }
    const collected: EventEnvelope[] = [];
    const filter: EventLogFilter = { entity_type: "arm" };
    const count = await svc.replay(
      (e) => {
        collected.push(e);
      },
      { filter },
    );
    expect(count).toBe(5);
    expect(collected.every((e) => e.entity_type === "arm")).toBe(true);
  });

  it("replay supports an async handler", async () => {
    for (let i = 0; i < 5; i++) {
      await svc.append(makeInputForReplay({ entity_id: `arm-${i}` }));
    }
    const collected: string[] = [];
    const count = await svc.replay(async (e) => {
      await new Promise((r) => setTimeout(r, 2));
      collected.push(e.entity_id);
    });
    expect(count).toBe(5);
    expect(collected).toEqual(["arm-0", "arm-1", "arm-2", "arm-3", "arm-4"]);
  });

  it("replay processes events in ULID order matching insertion order", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 100; i++) {
      const env = await svc.append(makeInputForReplay({ entity_id: `arm-${i}` }));
      ids.push(env.event_id);
    }
    const collected: string[] = [];
    await svc.replay((e) => {
      collected.push(e.event_id);
    });
    expect(collected).toEqual(ids);
    expect(collected.toSorted()).toEqual(collected);
  });
});

describe("tail (M1-06)", () => {
  let tmpDir: string;
  let logPath: string;
  let svc: EventLogService;
  let controllers: AbortController[];

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "octo-event-log-tail-"));
    logPath = path.join(tmpDir, "octo", "events.jsonl");
    svc = new EventLogService({ path: logPath });
    controllers = [];
  });

  afterEach(() => {
    for (const c of controllers) {
      c.abort();
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function startTail(
    filter: EventLogFilter,
    collector: EventEnvelope[],
    fromBeginning = false,
  ): { done: Promise<void>; ctrl: AbortController } {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    const done = svc.tail(
      filter,
      (e) => {
        collector.push(e);
      },
      { signal: ctrl.signal, pollIntervalMs: 25, fromBeginning },
    );
    return { done, ctrl };
  }

  it("tail streams new events appended after start", async () => {
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({}, collected);
    // Give the poll loop a tick to initialize.
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 5; i++) {
      await svc.append(makeInputForReplay({ entity_id: `arm-${i}` }));
    }
    await waitForCollector(collected, 5);
    expect(collected.map((e) => e.entity_id)).toEqual([
      "arm-0",
      "arm-1",
      "arm-2",
      "arm-3",
      "arm-4",
    ]);
    ctrl.abort();
    await done;
  });

  it("tail filter by entity_type works", async () => {
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({ entity_type: "arm" }, collected);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInputForReplay({ entity_id: "arm-1" }));
    await svc.append(
      makeInputForReplay({
        entity_type: "grip",
        entity_id: "grip-1",
        event_type: "grip.created",
      }),
    );
    await svc.append(makeInputForReplay({ entity_id: "arm-2" }));
    await svc.append(
      makeInputForReplay({
        entity_type: "mission",
        entity_id: "mission-1",
        event_type: "mission.created",
      }),
    );
    await waitForCollector(collected, 2);
    // Give the poll loop one more cycle to confirm nothing else arrives.
    await new Promise((r) => setTimeout(r, 100));
    expect(collected).toHaveLength(2);
    expect(collected.every((e) => e.entity_type === "arm")).toBe(true);
    ctrl.abort();
    await done;
  });

  it("tail filter by entity_id works", async () => {
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({ entity_id: "arm-target" }, collected);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInputForReplay({ entity_id: "arm-other" }));
    await svc.append(makeInputForReplay({ entity_id: "arm-target" }));
    await svc.append(makeInputForReplay({ entity_id: "arm-other" }));
    await waitForCollector(collected, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(collected).toHaveLength(1);
    expect(collected[0].entity_id).toBe("arm-target");
    ctrl.abort();
    await done;
  });

  it("tail filter by event_type works", async () => {
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({ event_type: "arm.active" }, collected);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInputForReplay({ event_type: "arm.created" }));
    await svc.append(makeInputForReplay({ event_type: "arm.active" }));
    await svc.append(makeInputForReplay({ event_type: "arm.idle" }));
    await waitForCollector(collected, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(collected).toHaveLength(1);
    expect(collected[0].event_type).toBe("arm.active");
    ctrl.abort();
    await done;
  });

  it("tail with empty filter receives every event", async () => {
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({}, collected);
    await new Promise((r) => setTimeout(r, 50));
    for (let i = 0; i < 3; i++) {
      await svc.append(makeInputForReplay({ entity_id: `arm-${i}` }));
    }
    await waitForCollector(collected, 3);
    expect(collected).toHaveLength(3);
    ctrl.abort();
    await done;
  });

  it("tail starts streaming from end by default (fromBeginning: false)", async () => {
    // Append 5 historical events BEFORE tailing.
    for (let i = 0; i < 5; i++) {
      await svc.append(makeInputForReplay({ entity_id: `historical-${i}` }));
    }
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({}, collected);
    await new Promise((r) => setTimeout(r, 75));
    // Now append 2 new events.
    await svc.append(makeInputForReplay({ entity_id: "new-0" }));
    await svc.append(makeInputForReplay({ entity_id: "new-1" }));
    await waitForCollector(collected, 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(collected).toHaveLength(2);
    expect(collected.map((e) => e.entity_id)).toEqual(["new-0", "new-1"]);
    ctrl.abort();
    await done;
  });

  it("tail with fromBeginning: true reads existing content first", async () => {
    for (let i = 0; i < 5; i++) {
      await svc.append(makeInputForReplay({ entity_id: `historical-${i}` }));
    }
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({}, collected, true);
    await waitForCollector(collected, 5);
    await svc.append(makeInputForReplay({ entity_id: "new-0" }));
    await svc.append(makeInputForReplay({ entity_id: "new-1" }));
    await waitForCollector(collected, 7);
    expect(collected.map((e) => e.entity_id)).toEqual([
      "historical-0",
      "historical-1",
      "historical-2",
      "historical-3",
      "historical-4",
      "new-0",
      "new-1",
    ]);
    ctrl.abort();
    await done;
  });

  it("tail aborts cleanly via AbortSignal", async () => {
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({}, collected);
    await new Promise((r) => setTimeout(r, 50));
    const start = Date.now();
    ctrl.abort();
    await done;
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("tail throws when called with an already-aborted signal", async () => {
    const ctrl = new AbortController();
    controllers.push(ctrl);
    ctrl.abort();
    await expect(
      svc.tail({}, () => {}, { signal: ctrl.signal, pollIntervalMs: 25 }),
    ).rejects.toThrow(/aborted before start/);
  });

  it("tail handles file not yet existing", async () => {
    expect(existsSync(logPath)).toBe(false);
    const collected: EventEnvelope[] = [];
    const { done, ctrl } = startTail({}, collected);
    await new Promise((r) => setTimeout(r, 100));
    await svc.append(makeInputForReplay({ entity_id: "first" }));
    await waitForCollector(collected, 1);
    expect(collected[0].entity_id).toBe("first");
    ctrl.abort();
    await done;
  });
});
