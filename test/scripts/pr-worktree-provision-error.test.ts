import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatProvisionError } from "../../scripts/pr-lib/worktree-provision-error.mjs";
import { GatewayStateOwnerContentionError } from "../../src/infra/gateway-state-owner.js";
import { markSqliteNativeOpenFailure } from "../../src/infra/sqlite-error-diagnostics.js";
import { markOpenClawStateDatabaseFailure } from "../../src/state/openclaw-state-db-failure.js";
import { OpenClawStateLeaseAcquisitionError } from "../../src/state/openclaw-state-lease-error.js";
import {
  hydrateOpenClawStateWorkerError,
  retainOpenClawStateWorkerErrorPayload,
} from "../../src/state/openclaw-state-worker-error.js";
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

  it("preserves distinct busy, lifecycle and worker failures without guessing a classification", () => {
    const busy = render(
      storage(
        Object.assign(new Error("synthetic busy"), { code: "SQLITE_BUSY", errcode: 5 }),
        "sqlite-busy",
      ),
    );
    expect(busy.outcome.reason).toBe("sqlite-busy");
    expect(busy.error.nodes[1]).toMatchObject({ code: "SQLITE_BUSY", errcode: 5 });
    const lifecycle = render(
      storage(new GatewayStateOwnerContentionError("/fixture/state.sqlite"), "lifecycle-busy"),
    );
    expect(lifecycle.outcome.reason).toBe("lifecycle-busy");
    expect(lifecycle.error.nodes[1]).toMatchObject({
      type: "state-owner-contention",
      databasePath: "/fixture/state.sqlite",
    });
    const worker = render(
      storage(Object.assign(new Error("synthetic worker unavailable"), { code: "unavailable" })),
    );
    expect(worker.outcome.reason).toBe("storage-error");
    expect(worker.error.nodes[1].code).toBe("unavailable");
  });

  it("retains shared and cyclic causes as a hydratable graph without changing the original", () => {
    const leaf = new Error("shared synthetic cause");
    const aggregate = new AggregateError([leaf, leaf], "aggregate", { cause: leaf });
    leaf.cause = aggregate;
    const error = storage(aggregate);
    const out = render(error);
    const carrier = new Error("wire carrier");
    retainOpenClawStateWorkerErrorPayload(carrier, out.error);
    const restored = hydrateOpenClawStateWorkerError(carrier);
    expect(restored).not.toBe(carrier);
    expect(restored.cause).toBeInstanceOf(AggregateError);
    const restoredAggregate = restored.cause as AggregateError;
    expect(restoredAggregate.errors[0]).toBe(restoredAggregate.errors[1]);
    expect(restoredAggregate.cause).toBe(restoredAggregate.errors[0]);
    expect(restoredAggregate.errors[0].cause).toBe(restoredAggregate);
    expect(error.cause).toBe(aggregate);
    expect(leaf.cause).toBe(aggregate);
    expect(aggregate.errors).toEqual([leaf, leaf]);
  });

  it("retains held and caller-aborted acquisition outcomes", () => {
    const held = render(
      new OpenClawStateLeaseAcquisitionError("lease", {
        kind: "held",
        holder: { owner: "fixture-owner", epoch: 7 },
      }),
    );
    expect(held.outcome).toEqual({ kind: "held", holder: { owner: "fixture-owner", epoch: 7 } });
    expect(held.error.nodes[0].code).toBe("OPENCLAW_STATE_LEASE_HELD");
    const aborted = render(
      new OpenClawStateLeaseAcquisitionError("lease", {
        kind: "aborted",
        reason: "caller-signal",
        elapsedMs: 23,
      }),
    );
    expect(aborted.outcome).toEqual({ kind: "aborted", reason: "caller-signal", elapsedMs: 23 });
    expect(aborted.error.nodes[0].code).toBe("OPENCLAW_STATE_LEASE_ABORTED");
  });

  it("never serializes arbitrary thrown objects, metadata or coercion hooks", () => {
    let called = 0;
    const opaque = {
      secret: "must-not-appear",
      toString() {
        called++;
        throw new Error("coercion");
      },
      toJSON() {
        called++;
        throw new Error("json");
      },
    };
    expect(formatProvisionError(opaque)).toBe(unavailable);
    const error = Object.assign(new Error("wrapper", { cause: opaque }), { arbitrary: opaque });
    const text = formatProvisionError(error);
    expect(text).not.toContain("must-not-appear");
    expect(render(error).error.nodes[0].cause).toEqual({ undefined: true });
    expect(called).toBe(0);
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
    const held = render(
      new OpenClawStateLeaseAcquisitionError("lease", {
        kind: "held",
        holder: { owner: "api_key=" + credential, epoch: 7 },
      }),
    );
    expect(held.outcome.holder.owner).not.toContain(credential);
  });

  it.each(["cause", "message", "name", "outcome"])(
    "falls back if a %s getter prevents safe reporting",
    (field) => {
      const error = storage(new Error("nested"));
      Object.defineProperty(error, field, {
        get() {
          throw new Error("unsafe diagnostic getter");
        },
      });
      expect(formatProvisionError(error)).toBe(unavailable);
    },
  );

  it.each(["message", "name", "outcome"])(
    "rejects an object-valued %s without calling toJSON",
    (field) => {
      let calls = 0;
      const opaque = {
        toJSON() {
          calls++;
          return { secret: "must-not-appear" };
        },
      };
      const error = storage(new Error("nested"));
      Object.defineProperty(error, field, {
        value: field === "outcome" ? { kind: "store-unavailable", reason: opaque } : opaque,
      });
      expect(formatProvisionError(error)).toBe(unavailable);
      expect(calls).toBe(0);
    },
  );

  it("reports ordinary errors without fabricating storage facts and safely handles primitives", () => {
    const out = render(new Error("plain failure"));
    expect(out.outcome).toBeUndefined();
    expect(out.error.nodes[0]).toMatchObject({ type: "error", message: "plain failure" });
    expect(formatProvisionError("plain failure")).toBe("plain failure");
    for (const value of [undefined, null, 0, true, Symbol("failure"), 1n]) {
      expect(formatProvisionError(value)).toBe(unavailable);
    }
  });

  it.skipIf(process.platform === "win32")(
    "reports the real native storage failure while retaining exit and recovery custody",
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
      expect(out.outcome).toEqual({ kind: "store-unavailable", reason: "storage-error" });
      expect(out.error.nodes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "OPENCLAW_STATE_LEASE_STORAGE_FAILED" }),
          expect.objectContaining({ code: "ERR_SQLITE_ERROR", errcode: 26 }),
        ]),
      );
      expect(readFileSync(database, "utf8")).toBe(corrupt);
      expect(existsSync(f.worktree)).toBe(false);
      expect(f.git(f.canonical, "rev-parse", "refs/heads/temp/pr-42")).toBe(f.main);
      expect(f.git(f.canonical, "rev-parse", "refs/openclaw/pr-operation-locks/42")).toMatch(
        /^[0-9a-f]{40}$/,
      );
    },
  );
});
