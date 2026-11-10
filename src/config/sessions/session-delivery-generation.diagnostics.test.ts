import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, onTestFinished, vi } from "vitest";
import { resolveManagedUpdateLeaseDatabasePath } from "../../infra/update-managed-service-handoff-lease.js";
import { flushLogger, getLogger, resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { hasOpenClawAgentDatabaseAsyncResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import {
  createLeaseDiagnostics,
  projectLeaseDiagnosticFrames,
} from "./session-delivery-generation-diagnostics.js";
import {
  SessionDeliveryGenerationUnavailableError,
  SessionDeliveryGenerationRevokedError,
} from "./session-delivery-generation-errors.js";
import {
  prepareCronRootSessionGeneration,
  prepareSessionGenerationFacts,
} from "./session-delivery-generation.js";
import * as entryReads from "./session-entry-read-runtime.js";

type RecordValue = {
  event: string;
  branch: string;
  state: { active: boolean; invalidated: boolean; revoked: boolean };
  flip: {
    kind: string;
    captured: boolean;
    frames?: string[];
    async?: boolean;
    notCapturedReason?: string;
  };
  producer: string;
  relation: string;
};
const original = {
  sessionId: "e1234567-1234-1234-1234-123456789abc",
  lifecycleRevision: "first",
  updatedAt: 1,
};
const message = "Session delivery generation is unavailable; retry after session storage is ready.";
it.aroundEach(async (run) => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "generation-diagnostics-"));
  setLoggerOverride({ level: "warn", file: path.join(logDir, "lease-diagnostics.log") });
  try {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const handoff = resolveManagedUpdateLeaseDatabasePath();
      const canonical = path.join(fs.realpathSync(path.dirname(handoff)), path.basename(handoff));
      expect(canonical).not.toBe("/private/tmp/openclaw/managed-update-handoffs.sqlite");
      expect(canonical).not.toBe("/tmp/openclaw/managed-update-handoffs.sqlite");
      expect(canonical.startsWith(fs.realpathSync(process.env.TMPDIR!) + path.sep)).toBe(true);
      try {
        await run();
      } finally {
        vi.restoreAllMocks();
      }
    });
  } finally {
    await flushLogger();
    resetLogger();
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});
function records() {
  const seen: RecordValue[] = [];
  getLogger().attachTransport((record) => {
    for (const value of [record, ...Object.values(record)]) {
      if (
        value &&
        typeof value === "object" &&
        "event" in value &&
        value.event === "lease-unavailable-first-refusal"
      ) {
        const { _meta: _metadata, ...payload } = value as Record<string, unknown>;
        seen.push(payload as RecordValue);
      }
    }
  });
  return seen;
}
async function fixture(cron = false, onRevoked?: (reason: unknown) => void) {
  const database = openOpenClawAgentDatabase({ agentId: "agent-canary" });
  const scope = {
    agentId: "agent-canary",
    storePath: database.path,
    sessionKey: cron ? "agent:agent-canary:cron:job" : "agent:agent-canary:diagnostic",
  };
  replaceSessionEntrySync(scope, original);
  const lease = cron
    ? await prepareCronRootSessionGeneration({ ...scope, ...original }, onRevoked)
    : await prepareSessionGenerationFacts({ ...scope, ...original });
  if (!lease) {
    throw new Error("Expected lease");
  }
  onTestFinished(() => lease.release());
  return { database, scope, lease };
}
function refusal(assert: () => void) {
  try {
    assert();
  } catch (error) {
    expect(error).toBeInstanceOf(SessionDeliveryGenerationUnavailableError);
    expect(error).toMatchObject({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE", message });
    expect((error as Error).cause).toBeUndefined();
    return error;
  }
  throw new Error("Expected unavailable refusal");
}
it("records the inner row refusal once with bounded private flip frames", async () => {
  const { database, lease } = await fixture();
  const seen = records();
  database.db.prepare("SELECT 'SQL_CANARY'").get();
  sessionChanges.emit({ all: true, scope: { agentId: "agent-canary", storePath: database.path } });
  refusal(lease.assertCurrent);
  refusal(lease.assertCurrent);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    event: "lease-unavailable-first-refusal",
    branch: "active-invalidated",
    state: { active: true, invalidated: true, revoked: false },
    flip: { kind: "row-invalidated", captured: true },
    producer: "unknown",
    relation: "observed-invalidation-call-chain",
  });
  const record = seen[0]!;
  expect(Object.keys(record).sort()).toEqual([
    "branch",
    "event",
    "flip",
    "producer",
    "relation",
    "state",
  ]);
  expect(Object.keys(record.state).sort()).toEqual(["active", "invalidated", "revoked"]);
  expect(Object.keys(record.flip).sort()).toEqual(["async", "captured", "frames", "kind"]);
  expect(record.flip.frames!.length).toBeGreaterThan(0);
  expect(record.flip.frames!.length).toBeLessThanOrEqual(4);
  for (const frame of record.flip.frames!) {
    expect(frame).toMatch(/^(src|dist)\/[^\s?#]+\.(ts|js|mjs|cjs):\d+:\d+$/);
  }
  expect(
    record.flip.frames!.some((frame) => frame.startsWith("src/sessions/session-row-changes.ts:")),
  ).toBe(true);
  expect(
    record.flip.frames!.some((frame) => frame.includes("session-delivery-generation-diagnostics")),
  ).toBe(false);
  const json = JSON.stringify(record);
  expect(Buffer.byteLength(json)).toBeLessThanOrEqual(1024);
  for (const canary of [
    "e1234567-1234-1234-1234-123456789abc",
    "agent-canary",
    database.path,
    process.env.HOME!,
    "SQL_CANARY",
    message,
  ]) {
    expect(json).not.toContain(canary);
  }
});
it("does not log release alone and diagnoses a later refusal without capture", async () => {
  const { lease } = await fixture();
  const seen = records();
  lease.release();
  expect(seen).toEqual([]);
  refusal(lease.assertCurrent);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.flip).toEqual({
    kind: "released",
    captured: false,
    notCapturedReason: "not-captured-kind",
  });
  expect(seen[0]!.branch).toBe("active-closed");
});
it("leaves genuine generation revocation unchanged and unlogged", async () => {
  const { scope, lease } = await fixture();
  const { lease: other } = await fixture(true);
  const seen = records();
  replaceSessionEntrySync(scope, { ...original, lifecycleRevision: "successor" });
  for (let attempt = 0; attempt < 2; attempt++) {
    let failure: unknown;
    try {
      lease.assertCurrent();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(SessionDeliveryGenerationRevokedError);
    expect(failure).toMatchObject({
      code: "SESSION_DELIVERY_GENERATION_REVOKED",
      message: "The original session generation no longer accepts this delivery.",
    });
  }
  expect(seen).toEqual([]);
  other.release();
  refusal(other.assertCurrent);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.branch).toBe("active-closed");
});
it("records an untagged prepare failure before cleanup and preserves its cause", async () => {
  const storePath = path.join(process.env.OPENCLAW_STATE_DIR!, "malformed.sqlite");
  fs.writeFileSync(storePath, "MALFORMED_DATABASE_CANARY");
  const seen = records();
  const callback = vi.fn();
  let sourceError: unknown;
  const read = entryReads.withSessionEntriesFromStoresInWorker;
  vi.spyOn(entryReads, "withSessionEntriesFromStoresInWorker").mockImplementation(
    (inputs, consume, options) =>
      read(inputs, consume, options).catch((error: unknown) => {
        sourceError = error;
        throw error;
      }),
  );
  const failure: unknown = await prepareCronRootSessionGeneration(
    {
      agentId: "agent-canary",
      storePath,
      sessionKey: "agent:agent-canary:cron:broken",
      ...original,
    },
    callback,
  ).then(
    (lease) => {
      lease?.release();
      throw new Error("Expected prepare failure");
    },
    (error: unknown) => error,
  );
  expect(sourceError).toBeInstanceOf(Error);
  expect(failure).toBeInstanceOf(SessionDeliveryGenerationUnavailableError);
  expect(failure).toMatchObject({ code: "SESSION_DELIVERY_GENERATION_UNAVAILABLE", message });
  if (!(failure instanceof Error)) {
    throw new Error("Expected unavailable error");
  }
  expect(failure.cause).toBe(sourceError);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    branch: "prepare-fallback",
    state: { active: true, invalidated: false, revoked: false },
    flip: { kind: "none", captured: false, notCapturedReason: "no-flip" },
  });
  await closeOpenClawAgentDatabaseByPathAsync(storePath);
  expect(callback).not.toHaveBeenCalled();
  expect(hasOpenClawAgentDatabaseAsyncResources({ path: storePath })).toBe(false);
  expect(fs.readFileSync(storePath, "utf8")).toBe("MALFORMED_DATABASE_CANARY");
  expect(JSON.stringify(seen)).not.toContain("MALFORMED_DATABASE_CANARY");
});
it("keeps row invalidation effective when diagnostic capture throws", async () => {
  const { database, lease } = await fixture();
  const seen = records();
  vi.spyOn(Error, "captureStackTrace").mockImplementation(() => {
    throw new Error("CAPTURE_CANARY");
  });
  sessionChanges.emit({ all: true, scope: { agentId: "agent-canary", storePath: database.path } });
  refusal(lease.assertCurrent);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({
    branch: "active-invalidated",
    state: { active: true, invalidated: true, revoked: false },
    flip: { kind: "row-invalidated", captured: false, notCapturedReason: "capture-failed" },
  });
  expect(JSON.stringify(seen)).not.toContain("CAPTURE_CANARY");
});
it("keeps separate latches for two leases", async () => {
  const { scope, lease } = await fixture();
  const other = await prepareSessionGenerationFacts({ ...scope, ...original });
  onTestFinished(() => other.release());
  const seen = records();
  sessionChanges.emit({ all: true, scope: "runtime" });
  refusal(lease.assertCurrent);
  refusal(other.assertCurrent);
  expect(seen).toHaveLength(2);
});
it.each([false, true])(
  "retains resource-revoke before release, including throwing logger=%s",
  async (throwing) => {
    const callback = vi.fn();
    const { database, lease } = await fixture(true, callback);
    const seen = records();
    const log = throwing
      ? vi.spyOn(getLogger(), "warn").mockImplementation(() => {
          throw new Error("LOGGER_CANARY");
        })
      : undefined;
    await closeOpenClawAgentDatabaseByPathAsync(database.path, "agent-canary");
    const callsAfterClose = callback.mock.calls.length;
    // The existing close owner invokes revoke, then close (which invokes revoke again).
    // Diagnostics must preserve both notifications, not impose once-only authority callbacks.
    expect(callsAfterClose).toBe(2);
    expect(seen).toHaveLength(0);
    if (log) {
      expect(log).not.toHaveBeenCalled();
    }
    const failure = refusal(lease.assertCurrent);
    expect(callback.mock.calls.at(-1)?.[0]).toBe(failure);
    refusal(lease.assertCurrent);
    expect(callback).toHaveBeenCalledTimes(4);
    if (throwing) {
      expect(log).toHaveBeenCalledTimes(1);
    } else {
      expect(seen).toHaveLength(1);
      expect(seen[0]!.flip.kind).toBe("resource-revoked");
      expect(seen[0]!.state.active).toBe(false);
    }
  },
);

it("projects only bounded package positions and rejects unsafe stack forms", () => {
  const root = "/package";
  const negative = [
    "/outside/src/a.ts:1:2",
    "/package/node_modules/a.ts:1:2",
    "/package/src/node_modules/a.ts:1:2",
    "node:internal:1:2",
    "vm:1:2",
    "eval (/package/src/a.ts:1:2)",
    "<anonymous>:1:2",
    "file:///package/src/a.ts?secret:1:2",
    "file:///package/src/a.ts#secret:1:2",
    "file:///package/src/../a.ts:1:2",
    "/package/src/../a.ts:1:2",
    "/package/src/a\rb.ts:1:2",
    "/package/src/a\nb.ts:1:2",
    "/package/src/a\u0001b.ts:1:2",
    "https:///package/src/a.ts:1:2",
  ];
  for (const frame of negative) {
    expect(projectLeaseDiagnosticFrames("    at " + frame, root)).toEqual({
      captured: false,
      notCapturedReason: "no-accepted-frames",
    });
  }
  const stack = Array.from(
    { length: 6 },
    (_, i) => "    at async fn (file:///package/src/a" + i + ".ts:1:2)",
  ).join("\n");
  expect(projectLeaseDiagnosticFrames(stack, root)).toEqual({
    captured: true,
    frames: ["src/a0.ts:1:2", "src/a1.ts:1:2", "src/a2.ts:1:2", "src/a3.ts:1:2"],
    async: true,
  });
  expect(projectLeaseDiagnosticFrames(stack, undefined)).toEqual({
    captured: false,
    notCapturedReason: "root-unresolved",
  });
});
it("returns the identical error and cause even if logging throws", () => {
  const cause = new Error("CAUSE_CANARY");
  const error = new SessionDeliveryGenerationUnavailableError({ cause });
  const log = vi.spyOn(getLogger(), "warn").mockImplementation(() => {
    throw new Error("LOGGER_CANARY");
  });
  const diag = createLeaseDiagnostics(() => ({ active: true, invalidated: false, revoked: false }));
  expect(diag.fallback("current-fallback", error)).toBe(error);
  expect(diag.fallback("prepare-fallback", error)).toBe(error);
  expect(error.cause).toBe(cause);
  expect(error.message).toBe(message);
  expect(log).toHaveBeenCalledTimes(1);
});

it("drops over-budget projected frames without leaking custom error text", () => {
  const seen = records();
  const stack = "Error\n    at fn (" + path.resolve("src", "a".repeat(1100) + ".ts") + ":1:2)";
  vi.spyOn(Error, "captureStackTrace").mockImplementation((holder) =>
    Object.defineProperty(holder, "stack", { value: stack }),
  );
  const diag = createLeaseDiagnostics(() => ({ active: false, invalidated: true, revoked: false }));
  diag.flip("row-invalidated");
  diag.flip("released");
  const error = new Error("ERROR_POLICY_SCOPE_CANARY");
  expect(diag.unavailable("active-invalidated", error)).toBe(error);
  expect(seen).toHaveLength(1);
  expect(seen[0]!.flip).toEqual({
    kind: "row-invalidated",
    captured: false,
    notCapturedReason: "budget",
  });
  expect(Buffer.byteLength(JSON.stringify(seen[0]))).toBeLessThanOrEqual(1024);
  expect(JSON.stringify(seen[0])).not.toContain(error.message);
});
