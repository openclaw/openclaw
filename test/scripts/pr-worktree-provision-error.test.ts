import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatProvisionError } from "../../scripts/pr-lib/worktree-provision-error.mjs";
import { GatewayStateOwnerContentionError } from "../../src/infra/gateway-state-owner.js";
import { markSqliteNativeOpenFailure } from "../../src/infra/sqlite-error-diagnostics.js";
import { markOpenClawStateDatabaseFailure } from "../../src/state/openclaw-state-db-failure.js";
import { OpenClawStateLeaseAcquisitionError } from "../../src/state/openclaw-state-lease-error.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createMainRefreshFixture } from "./pr-main-refresh.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const unavailable = "Provisioning failed; diagnostic unavailable.";
const storage = (
  cause: unknown,
  reason: "sqlite-busy" | "lifecycle-busy" | "storage-error" = "storage-error",
) =>
  new OpenClawStateLeaseAcquisitionError(
    "managed worktree allocation lease",
    { kind: "store-unavailable", reason },
    cause,
  );
const render = (error: unknown) => JSON.parse(formatProvisionError(error));

describe("native PR provisioning diagnostics", () => {
  it("preserves SQLite extended codes, errno, native-open provenance and database path", () => {
    const leaf = Object.assign(new Error("synthetic I/O refusal"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 266,
      errno: -5,
    });
    markSqliteNativeOpenFailure(leaf);
    markOpenClawStateDatabaseFailure(leaf, "/fixture/refused.sqlite");
    const out = render(storage(leaf));
    expect(out.outcome).toEqual({ kind: "store-unavailable", reason: "storage-error" });
    const root = out.error.nodes[out.error.root];
    expect(root.leaseCode).toBe("OPENCLAW_STATE_LEASE_STORAGE_FAILED");
    expect(out.error.nodes[root.cause.ref]).toMatchObject({
      code: "ERR_SQLITE_ERROR",
      errcode: 266,
      errno: -5,
      nativeOpen: true,
      stateDatabasePath: "/fixture/refused.sqlite",
    });
  });

  it.each([
    [
      "sqlite-busy",
      Object.assign(new Error("busy"), { code: "SQLITE_BUSY", errcode: 5 }),
      { code: "SQLITE_BUSY", errcode: 5 },
    ],
    [
      "lifecycle-busy",
      new GatewayStateOwnerContentionError("/fixture/state.sqlite"),
      { type: "state-owner-contention", databasePath: "/fixture/state.sqlite" },
    ],
    [
      "storage-error",
      Object.assign(new Error("worker unavailable"), { code: "unavailable" }),
      { code: "unavailable" },
    ],
  ] as const)("preserves %s without guessing a classification", (reason, error, fields) => {
    const out = render(storage(error, reason));
    expect(out.outcome.reason).toBe(reason);
    expect(out.error.nodes[1]).toMatchObject(fields);
  });

  it.each([
    { outcome: { kind: "held", holder: { owner: "fixture-owner", epoch: 7 } }, code: "HELD" },
    { outcome: { kind: "aborted", reason: "caller-signal", elapsedMs: 23 }, code: "ABORTED" },
  ] as const)("retains $outcome.kind acquisition outcomes", ({ outcome, code }) => {
    const out = render(new OpenClawStateLeaseAcquisitionError("lease", outcome));
    expect(out.outcome).toEqual(outcome);
    expect(out.error.nodes[0].code).toBe(`OPENCLAW_STATE_LEASE_${code}`);
  });

  it("never serializes arbitrary thrown objects, metadata or coercion hooks", () => {
    const coercion = vi.fn(() => {
      throw new Error("unsafe coercion");
    });
    const opaque = { secret: "must-not-appear", toString: coercion, toJSON: coercion };
    expect(formatProvisionError(opaque)).toBe(unavailable);
    const error = Object.assign(new Error("wrapper", { cause: opaque }), { arbitrary: opaque });
    const text = formatProvisionError(error);
    expect(text).not.toContain("must-not-appear");
    expect(render(error).error.nodes[0].cause).toEqual({ undefined: true });
    expect(coercion).not.toHaveBeenCalled();
  });

  it("redacts nested messages, scalar causes, top-level strings and outcome fields", () => {
    const credential = ["sk", "fixturesecretabcdefghijklmnopqrstuvwxyz0123456789"].join("-");
    const error = storage(
      new Error("Authorization: Bearer " + credential, { cause: "api_key=" + credential }),
    );
    const text = formatProvisionError(error);
    expect(text).not.toContain(credential);
    expect(text).toContain("***");
    expect(() => JSON.parse(text)).not.toThrow();
    expect(formatProvisionError("Authorization: Bearer " + credential)).not.toContain(credential);
    const outcome = { kind: "held", holder: { owner: "api_key=" + credential, epoch: 7 } } as const;
    const held = render(new OpenClawStateLeaseAcquisitionError("lease", outcome));
    expect(held.outcome.holder.owner).not.toContain(credential);
  });

  it.each([
    ...["cause", "message", "name", "outcome"].map((field) => ({ field, getter: true })),
    ...["message", "name", "outcome"].map((field) => ({ field, getter: false })),
  ])("safely rejects $field diagnostics (getter=$getter)", ({ field, getter }) => {
    const toJSON = vi.fn(() => ({ secret: "must-not-appear" }));
    const error = storage(new Error("nested"));
    Object.defineProperty(
      error,
      field,
      getter
        ? {
            get() {
              throw new Error("unsafe diagnostic getter");
            },
          }
        : {
            value:
              field === "outcome" ? { kind: "store-unavailable", reason: { toJSON } } : { toJSON },
          },
    );
    expect(formatProvisionError(error)).toBe(unavailable);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it.each([
    "plain failure",
    "state lease heartbeat is not responsive (phase=verify, trigger=deadline, requestId=2, elapsedMs=1000, responseRemainingMs=0, operationRemainingMs=59000, leaseRemainingMs=59000, status=1, renewalProgress=2, completedRequestId=1)",
  ])("reports ordinary errors without fabricating storage facts: %s", (message) => {
    const out = render(new Error(message));
    expect(out.outcome).toBeUndefined();
    expect(out.error.nodes).toEqual([{ type: "error", name: "Error", message }]);
  });

  it("safely handles primitives", () => {
    expect(formatProvisionError("plain failure")).toBe("plain failure");
    for (const value of [undefined, null, 0, true, Symbol("failure"), 1n]) {
      expect(formatProvisionError(value)).toBe(unavailable);
    }
  });

  it.skipIf(process.platform === "win32")(
    "reports the real native storage failure, keeps its exit status, and releases the drained lock",
    () => {
      const f = createMainRefreshFixture(tempDirs.make("openclaw-pr-diagnostic-"), {
        precreateWorktree: false,
      });
      f.env.OPENCLAW_STATE_DIR = join(f.root, "state");
      f.env.OPENCLAW_CONFIG_PATH = join(f.root, "config.json");
      writeFileSync(f.env.OPENCLAW_CONFIG_PATH, "{}\n");
      const state = join(f.canonical, ".local", "pr-state", "state");
      mkdirSync(state, { recursive: true });
      const database = join(state, "openclaw.sqlite");
      const corrupt = "private fixture: not a SQLite database\n";
      writeFileSync(database, corrupt);
      const result = f.run("review-init");
      f.assertPrivateHandoffVerified();
      expect(result.status, result.stderr).toBe(1);
      expect(result.stderr).toContain("[pr-worktree-provision] FAILED (exit 1)");
      const report = result.stderr.split("\n").find((line) => line.startsWith('{"error":'));
      expect(report, result.stderr).toBeDefined();
      const out = JSON.parse(report!);
      expect(out.outcome, report).toEqual({ kind: "store-unavailable", reason: "storage-error" });
      expect(out.error.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED" }),
          expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 26 }),
        ]),
      );
      expect(readFileSync(database, "utf8")).toBe(corrupt);
      expect(existsSync(f.worktree)).toBe(false);
      expect(f.git(f.canonical, "rev-parse", "refs/heads/temp/pr-42")).toBe(f.main);
      expect(result.stderr).toContain("Released the operation lock for PR #42 after exit code 1");
      expect(f.git(f.canonical, "for-each-ref", "refs/openclaw/pr-operation-locks")).toBe("");
    },
  );
});
