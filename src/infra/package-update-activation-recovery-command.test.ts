import { spawnSync } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { withUpdateCommandExecutor } from "../cli/update-cli/update-command-executor.js";
import { readBytes } from "./package-update-activation-fixtures.test-support.js";
import {
  openPackageActivationJournal,
  resolvePackageActivationControl,
  resolvePackageActivationHelper,
  resolvePackageActivationJournalPath,
} from "./package-update-activation-journal.js";
import { createPackageActivationLifetimeFixture } from "./package-update-activation-lifetime.test-support.js";
import { prepareRemountedPublication } from "./package-update-activation-remount.test-support.js";
import { packageActivationRuntimeEntrypoint } from "./package-update-activation-runtime-assets.js";
import {
  assertNoPendingPackageActivation,
  readPackageActivationReceipt,
  runPackageActivationRecovery,
  settlePendingPackageActivation,
} from "./package-update-activation.js";
import { createPublicationOwner } from "./package-update-publication-owner.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "./runtime-worker-url.js";

const fixture = createPackageActivationLifetimeFixture();
const recoveryWorker = resolveRuntimeWorkerUrl(packageActivationRuntimeEntrypoint);
function recoveryCommand(
  prepared: { anchor: string; operationId: string },
  env: NodeJS.ProcessEnv,
  preload: string[] = [],
) {
  const argv = [
    ...preload,
    ...resolveRuntimeWorkerArgv(recoveryWorker),
    "--anchor",
    prepared.anchor,
    "--operation",
    prepared.operationId,
  ];
  return (action: string) =>
    spawnSync(process.execPath, [...argv, action], {
      env,
      encoding: "utf8",
      timeout: 30_000,
    });
}
afterEach(async () => {
  try {
    await fixture.lifetime.cleanup();
  } finally {
    vi.restoreAllMocks();
  }
});

it.skipIf(process.platform === "win32").each([false, true])(
  "recovers after private permission repair and preserves package integrity checks (changed=%s)",
  (changed) =>
    fixture.lifetime.run(async () => {
      const { root } = fixture.setup();
      const packageModes = (directory: string, broaden: boolean) => {
        for (const name of fs.readdirSync(directory)) {
          const file = path.join(directory, name);
          if (fs.lstatSync(file).isDirectory()) {
            packageModes(file, broaden);
          } else {
            fs.chmodSync(file, broaden ? 0o650 : 0o600);
          }
        }
        fs.chmodSync(directory, broaden ? 0o750 : 0o700);
      };
      const prepared = await fixture.prepare(() => {
        packageModes(path.join(root, "stage/lib/node_modules/openclaw"), false);
      });
      const journal = openPackageActivationJournal(prepared.anchor);
      const originalRename = fsp.rename;
      const interrupted = vi.spyOn(fsp, "rename").mockImplementation(async (from, to) => {
        if (from === path.join(prepared.anchor, "candidate")) {
          throw new Error("interrupted candidate publication");
        }
        return originalRename(from, to);
      });
      await expect(
        withUpdateCommandExecutor(
          journal.read().descriptor.operationId,
          async (executor) => {
            const fence = await executor.enter(prepared.packageRoot);
            await createPublicationOwner(prepared.anchor, journal, fence.assertCurrent).publish(
              false,
            );
          },
          { existingAuthority: journal.read().descriptor.authority },
        ),
      ).rejects.toThrow("interrupted candidate publication");
      interrupted.mockRestore();
      const privateObjects = [
        [prepared.anchor, 0o700],
        [resolvePackageActivationControl(prepared.anchor), 0o700],
        [resolvePackageActivationJournalPath(prepared.anchor), 0o600],
        [resolvePackageActivationHelper(prepared.anchor), 0o600],
      ] as const;
      const broadenPermissions = () => {
        for (const [file, mode] of privateObjects) {
          fs.chmodSync(file, mode | 0o050);
        }
      };
      broadenPermissions();
      packageModes(path.join(prepared.anchor, "candidate"), true);
      await expect(
        runPackageActivationRecovery(prepared.anchor, "repair", prepared.operationId),
      ).resolves.toMatchObject({ phase: "publication-complete" });
      for (const [file, mode] of privateObjects) {
        expect(fs.statSync(file).mode & 0o777).toBe(mode);
      }
      expect(fs.readFileSync(prepared.launcher, "utf8")).toBe("candidate launcher\n");
      expect(fs.statSync(path.join(prepared.packageRoot, "dist/index.js")).mode & 0o777).toBe(
        0o600,
      );
      expect(
        JSON.parse(fs.readFileSync(path.join(prepared.packageRoot, "package.json"), "utf8")),
      ).toMatchObject({ version: "2.0.0" });

      broadenPermissions();
      if (changed) {
        const payload = path.join(prepared.packageRoot, "dist/index.js");
        fs.writeFileSync(payload, "changed package contents\n");
        await expect(
          runPackageActivationRecovery(prepared.anchor, "retire", prepared.operationId),
        ).rejects.toThrow("Package publication object changed");
        expect(fs.readFileSync(payload, "utf8")).toBe("changed package contents\n");
        expect(fs.existsSync(path.join(prepared.anchor, "previous/package.json"))).toBe(true);
      } else {
        await expect(
          runPackageActivationRecovery(prepared.anchor, "retire", prepared.operationId),
        ).resolves.toMatchObject({ phase: "complete" });
        expect(fs.existsSync(prepared.anchor)).toBe(false);
        expect(() => assertNoPendingPackageActivation(prepared.packageRoot)).not.toThrow();
      }
    }),
);

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
      const run = recoveryCommand(prepared, childGuardEnv(process.env));
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
      expect(readBytes(retained, "control", "operation.sqlite")).toEqual(completedBytes);
      expect(() => assertNoPendingPackageActivation(prepared.packageRoot)).not.toThrow();
    }),
);

it.skipIf(process.platform === "win32").each(["settle", "archive-sync-fails"] as const)(
  "a separate helper settles only the verified unfinished remounted publication: %s",
  (scenario) =>
    fixture.lifetime.run(async () => {
      const { root, childGuardEnv } = fixture.setup();
      const f = await prepareRemountedPublication(fixture, root);
      const preload = path.join(root, "archive-sync-failure.mjs");
      if (scenario === "archive-sync-fails") {
        // Inject at the filesystem boundary after custody really moved. The
        // standalone command must expose the owner's unconfirmed-archive warning.
        fs.writeFileSync(
          preload,
          `import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
const rename = fs.renameSync;
const sync = fs.fsyncSync;
let moved = false;
fs.renameSync = (source, destination) => {
  const result = rename(source, destination);
  if (String(source) === ${JSON.stringify(`${f.anchor}.control`)}) moved = true;
  return result;
};
fs.fsyncSync = (fd) => {
  if (moved && fs.fstatSync(fd).isDirectory()) {
    moved = false;
    throw Object.assign(new Error("archive directory sync failed after control rename"), { code: "EIO" });
  }
  return sync(fd);
};
syncBuiltinESMExports();
`,
        );
      }
      const run = recoveryCommand(
        f,
        childGuardEnv(process.env),
        scenario === "archive-sync-fails" ? ["--import", preload] : [],
      );
      const before = fs.readFileSync(f.journalPath);
      for (const action of ["status", "retire"]) {
        const refusal = run(action);
        expect(refusal.status, refusal.stderr).toBe(1);
        expect(refusal.stderr).toContain("does not match its installation");
        expect(fs.readFileSync(f.journalPath)).toEqual(before);
      }
      const result = run("repair");
      expect(result.error, result.stderr).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        phase: "complete",
        operationId: f.operationId,
      });
      expect(result.stderr).toContain("No package was republished and no service was restarted");
      if (scenario === "archive-sync-fails") {
        expect(result.stderr).toContain("Closed recovery evidence could not be fully archived");
        expect(result.stderr).toContain("archive directory sync failed after control rename");
      }
      const retained = `${f.anchor}.superseded-${f.operationId}`;
      expect(fs.existsSync(path.join(retained, "previous/package.json"))).toBe(true);
      expect(fs.existsSync(path.join(retained, "control/recovery.mjs"))).toBe(true);
      expect(fs.existsSync(f.journalPath)).toBe(false);
      expect(() => assertNoPendingPackageActivation(f.packageRoot)).not.toThrow();
    }),
);
