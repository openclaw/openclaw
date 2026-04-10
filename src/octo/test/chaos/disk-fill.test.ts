// Octopus Orchestrator -- chaos test: disk fill on events.jsonl (M1-27)
//
// Simulates ENOSPC (disk full) by intercepting `node:fs/promises` via
// vi.mock and toggling a fault flag. Verifies that:
//   1. Failed writes throw a diagnosable ENOSPC error
//   2. No partial / corrupt lines are left in the log file
//   3. Successful writes resume cleanly after the fault clears
//   4. ULID monotonicity is preserved across the gap
//
// Boundary discipline (OCTO-DEC-033):
//   Only `node:*` builtins, `vitest`, and relative imports inside
//   `src/octo/` are permitted.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Fault injection via vi.mock ------------------------------------------
//
// ESM module namespaces are frozen, so vi.spyOn cannot redefine exports.
// Instead we mock the entire module and delegate to the real implementation
// unless the fault flag is set.

let enospcFaultActive = false;

function makeEnospcError(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error("ENOSPC: no space left on device, write");
  err.code = "ENOSPC";
  err.errno = -28;
  err.syscall = "write";
  return err;
}

vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    appendFile: async (...args: Parameters<typeof real.appendFile>) => {
      if (enospcFaultActive) {
        throw makeEnospcError();
      }
      return real.appendFile(...args);
    },
  };
});

// Import EventLogService AFTER the mock is registered so it picks up the
// intercepted `appendFile`.
const { EventLogService } = await import("../../head/event-log.ts");
type AppendInput = import("../../head/event-log.ts").AppendInput;

function makeInput(overrides: Partial<AppendInput> = {}): AppendInput {
  return {
    schema_version: 1,
    entity_type: "arm",
    entity_id: "arm-chaos",
    event_type: "arm.created",
    actor: "head",
    payload: { chaos: true },
    ...overrides,
  };
}

/** Parse all non-empty lines from the log file; each must be valid JSON. */
function readLogLines(filePath: string): Record<string, unknown>[] {
  const raw = readFileSync(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.length > 0)
    .map((line, idx) => {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) {
        throw new Error(`Line ${idx + 1} is not a JSON object`);
      }
      return parsed as Record<string, unknown>;
    });
}

describe("chaos: disk fill on events.jsonl (M1-27)", () => {
  let tmpDir: string;
  let logPath: string;
  let svc: InstanceType<typeof EventLogService>;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "octo-chaos-disk-fill-"));
    logPath = path.join(tmpDir, "octo", "events.jsonl");
    mkdirSync(path.dirname(logPath), { recursive: true });
    svc = new EventLogService({ path: logPath });
    enospcFaultActive = false;
  });

  afterEach(() => {
    enospcFaultActive = false;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("ENOSPC during append throws diagnosable error and leaves no corrupt lines", async () => {
    // Phase 1: baseline -- 5 successful appends.
    for (let i = 0; i < 5; i++) {
      await svc.append(makeInput({ entity_id: `arm-${i}` }));
    }
    expect(readLogLines(logPath)).toHaveLength(5);

    // Phase 2: inject ENOSPC fault.
    enospcFaultActive = true;

    for (let i = 0; i < 3; i++) {
      const err: unknown = await svc
        .append(makeInput({ entity_id: `arm-fail-${i}` }))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as NodeJS.ErrnoException).code).toBe("ENOSPC");
    }

    // Phase 3: remove fault -- "disk freed".
    enospcFaultActive = false;

    for (let i = 0; i < 2; i++) {
      await svc.append(makeInput({ entity_id: `arm-post-${i}` }));
    }

    // Verify: exactly 7 valid JSON lines, no corruption.
    const lines = readLogLines(logPath);
    expect(lines).toHaveLength(7);
  }, 10_000);

  it("ULID monotonicity is preserved across the ENOSPC gap", async () => {
    // Write 5 baseline events.
    const preIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      const env = await svc.append(makeInput({ entity_id: `arm-${i}` }));
      preIds.push(env.event_id);
    }

    // Inject ENOSPC for 3 failed writes.
    enospcFaultActive = true;
    for (let i = 0; i < 3; i++) {
      await svc.append(makeInput({ entity_id: `arm-fail-${i}` })).catch(() => {});
    }
    enospcFaultActive = false;

    // Write 2 recovery events.
    const postIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const env = await svc.append(makeInput({ entity_id: `arm-post-${i}` }));
      postIds.push(env.event_id);
    }

    // All 7 persisted IDs must be strictly ascending.
    const allIds = [...preIds, ...postIds];
    const sorted = allIds.toSorted();
    expect(sorted).toEqual(allIds);
    expect(new Set(allIds).size).toBe(7);
  }, 10_000);

  it("ENOSPC error contains diagnosable disk-full indicator", async () => {
    enospcFaultActive = true;

    const err: unknown = await svc.append(makeInput()).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    const errObj = err as NodeJS.ErrnoException;
    // The error must be diagnosable: either .code === "ENOSPC" or message
    // contains "ENOSPC", so upstream callers can detect disk-full and
    // enter degraded state / emit anomaly.
    expect(errObj.code === "ENOSPC" || (errObj.message ?? "").includes("ENOSPC")).toBe(true);
  }, 10_000);

  it("every persisted line is valid JSON after fault cycle (no partial writes)", async () => {
    // Baseline writes.
    for (let i = 0; i < 5; i++) {
      await svc.append(makeInput({ entity_id: `arm-${i}` }));
    }

    // Fault phase: mock rejects without calling the real appendFile, so
    // no bytes reach the file -- validating the atomic-or-nothing contract.
    enospcFaultActive = true;
    for (let i = 0; i < 3; i++) {
      await svc.append(makeInput({ entity_id: `arm-fail-${i}` })).catch(() => {});
    }
    enospcFaultActive = false;

    // Recovery writes.
    for (let i = 0; i < 2; i++) {
      await svc.append(makeInput({ entity_id: `arm-post-${i}` }));
    }

    // Read raw file and assert every non-empty line parses as JSON.
    const raw = readFileSync(logPath, "utf8");
    const lines = raw.split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(7);
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow();
      const parsed: unknown = JSON.parse(line);
      expect(typeof parsed).toBe("object");
      expect(parsed).not.toBeNull();
      // Each line must have an event_id (envelope shape).
      expect(typeof (parsed as Record<string, unknown>).event_id).toBe("string");
    }
  }, 10_000);
});
