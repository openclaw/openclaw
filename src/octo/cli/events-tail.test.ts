// Octopus Orchestrator -- `openclaw octo events --tail` tests (M1-23)
//
// Covers:
//   - formatEventHuman: human-readable single-line output
//   - formatEventJson: JSON-per-line output
//   - runOctoEventsTail: streams events with filters, abort, json mode
//   - filter by entity_type, entity_id, event_type
//   - clean exit on abort
//   - already-aborted signal returns exit code 1

import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventLogService, type AppendInput } from "../head/event-log.ts";
import type { EventEnvelope } from "../wire/events.ts";
import { formatEventHuman, formatEventJson, runOctoEventsTail } from "./events-tail.ts";

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

let tmpDir: string;
let logPath: string;
let svc: EventLogService;
const controllers: AbortController[] = [];

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), "octo-events-tail-test-"));
  logPath = path.join(tmpDir, "events.jsonl");
  svc = new EventLogService({ path: logPath });
});

afterEach(() => {
  for (const c of controllers) {
    c.abort();
  }
  controllers.length = 0;
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeInput(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    schema_version: 1,
    entity_type: "arm",
    entity_id: "arm-1",
    event_type: "arm.created",
    actor: "test",
    payload: {},
    ...overrides,
  };
}

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

function startTail(
  opts: Parameters<typeof runOctoEventsTail>[1],
  lines: string[],
): { done: Promise<number>; ctrl: AbortController } {
  const ctrl = new AbortController();
  controllers.push(ctrl);
  const out = {
    write: (s: string) => {
      lines.push(s);
    },
  };
  const done = runOctoEventsTail(svc, opts, ctrl.signal, out);
  return { done, ctrl };
}

// ──────────────────────────────────────────────────────────────────────────
// formatEventHuman
// ──────────────────────────────────────────────────────────────────────────

describe("formatEventHuman", () => {
  it("renders a single event as a human-readable line", () => {
    const envelope: EventEnvelope = {
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      schema_version: 1,
      entity_type: "arm",
      entity_id: "arm-42",
      event_type: "arm.created",
      ts: "2026-01-15T10:30:00.000Z",
      actor: "operator",
      payload: {},
    };
    const line = formatEventHuman(envelope);
    expect(line).toBe("2026-01-15T10:30:00.000Z [arm/arm-42] arm.created actor=operator");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// formatEventJson
// ──────────────────────────────────────────────────────────────────────────

describe("formatEventJson", () => {
  it("renders a single event as a JSON line that round-trips", () => {
    const envelope: EventEnvelope = {
      event_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      schema_version: 1,
      entity_type: "grip",
      entity_id: "grip-7",
      event_type: "grip.completed",
      ts: "2026-01-15T10:30:00.000Z",
      actor: "scheduler",
      payload: { result: "ok" },
    };
    const json = formatEventJson(envelope);
    const parsed = JSON.parse(json) as EventEnvelope;
    expect(parsed).toEqual(envelope);
  });
});

// ──────────────────────────────────────────────────────────────────────────
// runOctoEventsTail
// ──────────────────────────────────────────────────────────────────────────

describe("runOctoEventsTail", () => {
  it("streams new events in human format by default", async () => {
    const lines: string[] = [];
    const { done, ctrl } = startTail({}, lines);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInput({ entity_id: "arm-0" }));
    await svc.append(makeInput({ entity_id: "arm-1" }));
    await waitForCollector(lines, 2);
    expect(lines[0]).toContain("[arm/arm-0]");
    expect(lines[0]).toContain("arm.created");
    expect(lines[1]).toContain("[arm/arm-1]");
    ctrl.abort();
    const code = await done;
    expect(code).toBe(0);
  });

  it("streams events as JSON-per-line with --json", async () => {
    const lines: string[] = [];
    const { done, ctrl } = startTail({ json: true }, lines);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInput({ entity_id: "arm-j" }));
    await waitForCollector(lines, 1);
    const parsed = JSON.parse(lines[0].trim()) as EventEnvelope;
    expect(parsed.entity_id).toBe("arm-j");
    expect(parsed.event_type).toBe("arm.created");
    ctrl.abort();
    const code = await done;
    expect(code).toBe(0);
  });

  it("filters by entity (entity_type)", async () => {
    const lines: string[] = [];
    const { done, ctrl } = startTail({ entity: "grip" }, lines);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInput({ entity_type: "arm", entity_id: "a1", event_type: "arm.created" }));
    await svc.append(
      makeInput({ entity_type: "grip", entity_id: "g1", event_type: "grip.created" }),
    );
    await svc.append(makeInput({ entity_type: "arm", entity_id: "a2", event_type: "arm.active" }));
    await waitForCollector(lines, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[grip/g1]");
    ctrl.abort();
    await done;
  });

  it("filters by entity-id", async () => {
    const lines: string[] = [];
    const { done, ctrl } = startTail({ entityId: "arm-target" }, lines);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInput({ entity_id: "arm-other" }));
    await svc.append(makeInput({ entity_id: "arm-target" }));
    await svc.append(makeInput({ entity_id: "arm-other" }));
    await waitForCollector(lines, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("arm-target");
    ctrl.abort();
    await done;
  });

  it("filters by event type", async () => {
    const lines: string[] = [];
    const { done, ctrl } = startTail({ type: "arm.active" }, lines);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInput({ event_type: "arm.created" }));
    await svc.append(makeInput({ event_type: "arm.active" }));
    await svc.append(makeInput({ event_type: "arm.idle" }));
    await waitForCollector(lines, 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("arm.active");
    ctrl.abort();
    await done;
  });

  it("aborts cleanly and returns exit code 0", async () => {
    const lines: string[] = [];
    const { done, ctrl } = startTail({}, lines);
    await new Promise((r) => setTimeout(r, 50));
    const start = Date.now();
    ctrl.abort();
    const code = await done;
    expect(code).toBe(0);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("returns exit code 1 when signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const out = { write: vi.fn() };
    const code = await runOctoEventsTail(svc, {}, ctrl.signal, out);
    expect(code).toBe(1);
    expect(out.write).not.toHaveBeenCalled();
  });

  it("combines multiple filters", async () => {
    const lines: string[] = [];
    const { done, ctrl } = startTail({ entity: "arm", type: "arm.active" }, lines);
    await new Promise((r) => setTimeout(r, 50));
    await svc.append(makeInput({ entity_type: "arm", event_type: "arm.created" }));
    await svc.append(makeInput({ entity_type: "arm", event_type: "arm.active", entity_id: "a1" }));
    await svc.append(
      makeInput({ entity_type: "grip", event_type: "grip.created", entity_id: "g1" }),
    );
    await svc.append(makeInput({ entity_type: "arm", event_type: "arm.active", entity_id: "a2" }));
    await waitForCollector(lines, 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("arm.active");
    expect(lines[1]).toContain("arm.active");
    ctrl.abort();
    await done;
  });
});
