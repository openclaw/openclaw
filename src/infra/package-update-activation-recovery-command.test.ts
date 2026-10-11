import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import {
  openPackageActivationJournal,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
  runPackageActivationRecovery,
  settlePendingPackageActivation,
} from "./package-update-activation.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const fixture = createPackageActivationLifetimeFixture();
const recoveryWorker = resolveRuntimeWorkerUrl(packageActivationRuntimeEntrypoint);
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

it.skipIf(process.platform === "win32")(
  "replays the pending receipt with the validated runtime when PATH has no node",
  () =>
    fixture.lifetime.run(async () => {
      const { root, childGuardEnv } = fixture.setup();
      // This fixture helper records command delivery; publication/recovery behavior
      // is exercised by the existing activation lifetime and runtime tests.
      fs.writeFileSync(
        path.join(root, "sealed.mjs"),
        "console.log(JSON.stringify({node:process.execPath,args:process.argv.slice(2)}));\n",
      );
      const prepared = await fixture.prepare();
      const command = readPackageActivationReceipt(prepared.packageRoot)?.recoveryCommand;
      if (!command) {
        throw new Error("Pending activation did not expose recovery");
      }
      expect(() => assertNoPendingPackageActivation(prepared.packageRoot)).toThrow(command);
      const emptyPath = path.join(root, "empty-path");
      fs.mkdirSync(emptyPath, { mode: 0o700 });
      const result = spawnSync("/bin/sh", ["-c", command], {
        env: childGuardEnv({ ...process.env, PATH: emptyPath }),
        encoding: "utf8",
        timeout: 10_000,
        killSignal: "SIGKILL",
      });
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        node: fs.realpathSync(process.execPath),
        args: ["--anchor", prepared.anchor, "--operation", prepared.operationId, "status"],
      });
    }),
);

it.skipIf(process.platform === "win32")(
  "an external helper preserves a completed remounted receipt and clears old-reader admission",
  () =>
    fixture.lifetime.run(async () => {
      const { childGuardEnv } = fixture.setup();
      const prepared = await fixture.prepare();
      const run = (action: string) =>
        spawnSync(
          process.execPath,
          [
            ...resolveRuntimeWorkerArgv(recoveryWorker),
            "--anchor",
            prepared.anchor,
            "--operation",
            prepared.operationId,
            action,
          ],
          { env: childGuardEnv(process.env), encoding: "utf8", timeout: 30_000 },
        );
      const journalPath = resolvePackageActivationJournalPath(prepared.anchor);
      const pendingBytes = fs.readFileSync(journalPath);
      const pending = run("retire");
      expect(pending.status, pending.stderr).toBe(1);
      expect(pending.stderr).toContain("recorded package recovery object");
      expect(fs.readFileSync(journalPath)).toEqual(pendingBytes);

      await runPackageActivationRecovery(prepared.anchor, "repair", prepared.operationId);
      await runPackageActivationRecovery(prepared.anchor, "retire", prepared.operationId);
      const record = openPackageActivationJournal(prepared.anchor).read();
      const db = new DatabaseSync(journalPath);
      try {
        db.prepare("UPDATE package_activation SET descriptor_json = ?, intent_json = ?").run(
          ...[record.descriptor, record.intent].map((value) =>
            JSON.stringify(value, (_key, entry: unknown) =>
              typeof entry === "string" && /^\d+:\d+$/u.test(entry)
                ? entry.replace(/^\d+/u, (device) => String(BigInt(device) + 1n))
                : entry,
            ),
          ),
        );
      } finally {
        db.close();
      }
      const completedBytes = fs.readFileSync(journalPath);
      const observed = run("status");
      expect(observed.status, observed.stderr).toBe(0);
      expect(JSON.parse(observed.stdout).phase).toBe("complete");
      expect(fs.readFileSync(journalPath)).toEqual(completedBytes);
      await expect(
        settlePendingPackageActivation(prepared.packageRoot, undefined, record),
      ).rejects.toThrow("Completed package receipt changed");
      expect(fs.readFileSync(journalPath)).toEqual(completedBytes);

      const retained = `${prepared.anchor}.superseded-${prepared.operationId}`;
      const collision = path.join(retained, "control");
      fs.mkdirSync(collision, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(collision, "keep.txt"), "existing archive");
      const blocked = run("repair");
      expect(blocked.status, blocked.stderr).toBe(1);
      expect(blocked.stderr).toContain("retry this recovery command before updating");
      expect(fs.readFileSync(journalPath)).toEqual(completedBytes);
      expect(fs.readFileSync(path.join(collision, "keep.txt"), "utf8")).toBe("existing archive");
      fs.rmSync(collision, { recursive: true });
      const result = run("retire");
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        phase: "complete",
        operationId: prepared.operationId,
        installKey: prepared.packageRoot,
      });
      expect(result.stderr).toContain(retained);
      expect(fs.existsSync(path.dirname(journalPath))).toBe(false);
      expect(fs.readFileSync(path.join(retained, "control", "operation.sqlite"))).toEqual(
        completedBytes,
      );
      expect(() => assertNoPendingPackageActivation(prepared.packageRoot)).not.toThrow();
    }),
);
