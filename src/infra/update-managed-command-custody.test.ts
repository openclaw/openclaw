import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../test/helpers/managed-handoff-isolation.js";
import {
  installPrivateUpdateHandoffStore,
  writePrivateUpdateHandoffChildGuard,
} from "../../test/helpers/private-update-handoff-store.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runUtf8CommandWithTimeout } from "../process/exec-runner.js";
import { withCommandProcessScope } from "../process/exec-spawn.js";
import { executeSqliteQuerySync } from "./kysely-sync.js";
import { createManagedCommandProcessCustody } from "./update-managed-command-custody.js";
import {
  createManagedHandoffLeaseDatabase,
  leaseQueries,
} from "./update-managed-service-handoff-database.js";
import { createManagedHandoffLeaseStore } from "./update-managed-service-handoff-lease.js";

const directories = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

function fixture() {
  const directory = fs.realpathSync(directories.make("command-custody-"));
  const privateTmp = path.join(directory, "private-tmp");
  fs.mkdirSync(privateTmp, { mode: 0o700 });
  const { databasePath } = installPrivateUpdateHandoffStore(privateTmp);
  const store = createManagedHandoffLeaseStore({ databasePath, serviceManagerEnv: {} });
  const roots = ["original", "candidate", "retained", "slot"].map((name) =>
    path.join(directory, name),
  );
  const rows = () =>
    createManagedHandoffLeaseDatabase(databasePath)(
      false,
      (db) =>
        executeSqliteQuerySync(
          db,
          leaseQueries(db).selectFrom("managed_update_handoffs").selectAll(),
        ).rows,
    );
  return { directory, privateTmp, databasePath, store, roots, rows };
}

describe.skipIf(process.platform === "win32")("managed command process custody", () => {
  it("retains live authority while a managed command binds and releases every reservation on normal completion", async () => {
    const f = fixture();
    const parents = f.roots.map((root) => {
      const result = f.store.acquire(root, "command", { kind: "update" });
      if (result.kind !== "acquired") {
        throw new Error("Missing parent fixture");
      }
      return result.lease;
    });
    const delegated = parents.map((parent) => {
      const result = f.store.acquire(
        `${parent.key}/.openclaw-update-child-delegated`,
        "command",
        { kind: "update" },
        false,
        undefined,
        parent,
      );
      if (result.kind !== "acquired") {
        throw new Error("Missing delegated fixture");
      }
      return result.lease;
    });
    const retained = await createManagedCommandProcessCustody({
      roots: delegated.map((parent) => parent.key),
      parents: delegated,
      runId: "command",
      assertCurrent() {
        for (const parent of parents) {
          expect(f.store.owns(parent, "executor")).toBe(true);
        }
      },
    });
    const result = await withCommandProcessScope(
      () =>
        runUtf8CommandWithTimeout(
          [
            process.execPath,
            "-e",
            "process.stdin.resume();process.stdin.on('end',()=>process.stdout.write('owned'));",
          ],
          {
            timeoutMs: 10_000,
            input: "finish",
            beforeInput(pid) {
              const commands = f.rows().filter((row) => row.install_root.endsWith("-command"));
              expect(commands).toHaveLength(f.roots.length);
              for (const row of commands) {
                expect(JSON.parse(row.payload_json)).toMatchObject({
                  action: { custody: "bound" },
                  executor: { pid },
                });
              }
            },
          },
        ),
      undefined,
      retained.custody,
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("owned");
    expect(f.rows().filter((row) => row.install_root.endsWith("-command"))).toEqual([]);
    retained.releaseAnchors();
    for (const parent of [...parents, ...delegated]) {
      expect(f.store.current(parent)).toBe(true);
    }
    expect(f.store.releaseAll(delegated)).toBe(true);
    expect(f.store.releaseAll(parents)).toBe(true);
  });

  it("pins before effects and permits only the original helper to release a confirmed non-start", async () => {
    const f = fixture();
    const retained = await createManagedCommandProcessCustody({
      roots: f.roots,
      runId: randomUUID(),
    });
    expect(retained.databasePath).toBe(f.databasePath);
    expect(f.rows()).toEqual([]);
    const reservation = retained.custody.reserve([process.execPath, "--version"]);
    expect(f.rows()).toHaveLength(f.roots.length * 2);
    for (const row of f.rows()) {
      const current = f.store.read(row.install_root);
      if (current.kind !== "current") {
        throw new Error("Missing command reservation");
      }
      expect(f.store.release(current.lease)).toBe(false);
      expect(f.store.bind(current.lease, process.pid)).toBeNull();
    }
    for (const root of f.roots) {
      expect(f.store.acquire(root, "next", { kind: "update" }).kind).toBe("busy");
    }
    reservation.settled();
    expect(f.rows()).toHaveLength(f.roots.length);
    for (const root of f.roots) {
      expect(f.store.acquire(root, "next", { kind: "update" }).kind).toBe("busy");
    }
    retained.releaseAnchors();
    expect(f.rows()).toEqual([]);
    for (const root of f.roots) {
      const acquired = f.store.acquire(root, "next", { kind: "update" });
      expect(acquired.kind).toBe("acquired");
      if (acquired.kind === "acquired") {
        expect(f.store.release(acquired.lease)).toBe(true);
      }
    }
  });

  it.each(["current", "legacy"])(
    "refuses unknown reservations and foreign receipts for %s updaters",
    async (driver) => {
      const f = fixture();
      const owner = await createManagedCommandProcessCustody({
        roots: f.roots,
        runId: driver === "legacy" ? "" : "owner",
        anchorOwner: "doctor:owner",
      });
      const other = await createManagedCommandProcessCustody({
        roots: f.roots,
        runId: driver === "legacy" ? "" : "other",
        anchorOwner: "doctor:other",
      });
      const reservation = owner.custody.reserve([process.execPath]);
      const claims = f.store.readCommandChildren(f.roots);
      try {
        expect(() => owner.prepareSettlement(process.pid, [])).toThrow(
          "Unmatched native command reservation",
        );
        expect(() => other.prepareSettlement(process.pid, [])).toThrow("belongs to another Doctor");
        expect(() =>
          other.prepareSettlement(process.pid + 1, [{ pid: process.pid, startedAt: null }]),
        ).toThrow("belongs to another Doctor");
        expect(f.store.readCommandChildren(f.roots)).toEqual(claims);
      } finally {
        reservation.settled();
        owner.releaseAnchors();
      }
    },
  );

  it("retains every installation after helper death until the tracked group exits, including orphan rows", async () => {
    const f = fixture();
    const binding = createManagedHandoffTestBinding(f.privateTmp);
    const childEnv = writePrivateUpdateHandoffChildGuard(f.databasePath, f.privateTmp);
    const env = childEnv({
      ...process.env,
      HOME: f.directory,
      OPENCLAW_STATE_DIR: path.join(f.directory, "state"),
    });
    const holder = spawn(process.execPath, ["-e", "process.stdin.resume()"], {
      env,
      detached: true,
      stdio: ["pipe", "ignore", "pipe"],
    });
    const closed = once(holder, "close");
    try {
      await once(holder, "spawn");
      if (!holder.pid) {
        throw new Error("Missing tracked child PID");
      }
      const pendingRoot = path.join(f.directory, "pending");
      const namespaces = f.roots
        .slice(0, -1)
        .map((root) => `${root}/.openclaw-update-child-delegated`);
      const child = path.join(f.directory, "custody-owner.mts");
      fs.writeFileSync(
        child,
        `
import { createManagedCommandProcessCustody } from ${JSON.stringify(new URL("./update-managed-command-custody.ts", import.meta.url).href)};
import { createManagedHandoffLeaseStore } from ${JSON.stringify(new URL("./update-managed-service-handoff-lease.ts", import.meta.url).href)};
const store = createManagedHandoffLeaseStore();
const parents = [];
const delegated = [];
for (const root of ${JSON.stringify(f.roots.slice(0, -1))}) {
  const admitted = store.acquire(root, "old-root", {kind:"update"});
  if (admitted.kind !== "acquired") throw new Error("Root fixture failed");
  parents.push(admitted.lease);
  const child = store.acquire(root + "/.openclaw-update-child-delegated", "doctor", {kind:"update"}, false, undefined, admitted.lease);
  if (child.kind !== "acquired") throw new Error("Delegated fixture failed");
  delegated.push(child.lease);
}
const command = await createManagedCommandProcessCustody({ roots: ${JSON.stringify(namespaces)}, parents: delegated, runId: "tracked-owner", assertCurrent() {
  if (parents.some((lease) => !store.owns(lease, "executor"))) throw new Error("Fixture authority changed");
} });
command.custody.reserve([process.execPath, "-e", "process.stdin.resume()"]).spawned({pid: ${holder.pid}, startedAt: null});
// Reopen an orphan produced before canonical anchors existed, without using the new producer.
const orphan = store.acquire(${JSON.stringify(`${f.roots.at(-1)!}/.openclaw-update-child-historical-command`)}, "tracked-owner", {kind:"update", custody:"reserved"});
if (orphan.kind !== "acquired" || !store.bindUpdateChildren([orphan.lease], ${holder.pid})) throw new Error("Historical orphan fixture failed");
(await createManagedCommandProcessCustody({ roots: [${JSON.stringify(pendingRoot)}], runId: "pending-owner", databaseIdentity: command.databaseIdentity })).custody.reserve([process.execPath]);
process.kill(process.pid, "SIGKILL");
`,
      );
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          fileURLToPath(new URL("../../scripts/tsx.mjs", import.meta.url)),
          binding.nodeOption,
          child,
        ],
        {
          cwd: fileURLToPath(new URL("../../", import.meta.url)),
          env,
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL",
        },
      );
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.signal, result.stderr).toBe("SIGKILL");
      assertManagedHandoffTestConsumer(binding, result.pid, path.resolve("src"));
      expect(f.store.read(f.roots.at(-1)!).kind).toBe("absent");
      const commands = f.rows().filter((row) => row.owner === "tracked-owner");
      expect(commands).toHaveLength(f.roots.length);
      for (const row of commands) {
        expect(JSON.parse(row.payload_json)).toMatchObject({
          action: { custody: "bound" },
          helper: { pid: result.pid },
          executor: { pid: holder.pid },
        });
      }
      for (const root of [...f.roots, pendingRoot]) {
        expect(f.store.acquire(root, "next", { kind: "update" }).kind).toBe("busy");
      }
      const pending = f.rows().find((row) => row.owner === "pending-owner");
      expect(pending).toBeDefined();
      const retained = f.store.read(pending!.install_root);
      if (retained.kind !== "current") {
        throw new Error("Missing pending reservation");
      }
      expect(f.store.releaseCommandReservation(retained.lease)).toBe(false);

      holder.kill("SIGKILL");
      await closed;
      for (const root of f.roots) {
        const acquired = f.store.acquire(root, "next", { kind: "update" });
        expect(acquired.kind).toBe("acquired");
        if (acquired.kind === "acquired") {
          expect(f.store.release(acquired.lease)).toBe(true);
        }
      }
      expect(f.store.acquire(pendingRoot, "next", { kind: "update" }).kind).toBe("busy");
    } finally {
      holder.kill("SIGKILL");
      await closed;
    }
  });
});
