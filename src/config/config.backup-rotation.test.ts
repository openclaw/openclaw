// Covers config backup rotation limits and snapshot behavior.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../infra/update-managed-service-handoff-database.js";
import { createPreUpdateConfigSnapshot, maintainConfigBackups } from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { createConfigIO } from "./io.factory.js";
import { withTempHome } from "./test-helpers.js";

async function expectRegularFile(filePath: string): Promise<void> {
  expect((await fs.stat(filePath)).isFile()).toBe(true);
}

async function expectPathMissing(filePath: string): Promise<void> {
  let error: { code?: unknown } | undefined;
  try {
    await fs.stat(filePath);
  } catch (err) {
    error = err as { code?: unknown };
  }
  expect(error?.code).toBe("ENOENT");
}

async function withConfigExecutor(
  home: string,
  operation: (assertCurrent: () => void, revoke: () => void) => Promise<void>,
) {
  const root = path.join(await fs.realpath(home), "package");
  await fs.mkdir(root);
  const databasePath = path.join(home, "control", "managed-update-handoffs.sqlite");
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  await withUpdateCommandExecutor(
    "config-backup-fence",
    async (executor) => {
      const fence = await executor.enter(root, { preflight: true });
      await operation(fence.assertCurrent, () => releaseUpdateCommandPreflightForHandoff(fence));
    },
    {
      existingAuthority: {
        ...captureManagedUpdateLeaseDatabaseIdentity(databasePath),
        installKey: root,
      },
    },
  );
}

describe("config backup rotation", () => {
  it("keeps five recovery points while preserving manual and pre-update backups", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const writeVersion = (version: number) =>
        fs.writeFile(configPath, JSON.stringify({ version }), "utf-8");
      const readVersion = async (suffix = "") => {
        const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
        return (JSON.parse(raw) as { version: number }).version;
      };
      const { existsSync } = await import("node:fs");
      const manualBackupPath = `${configPath}.bak.20260808`;
      const manualBackupContent = JSON.stringify({ version: "manual" });

      await writeVersion(0);
      await fs.writeFile(manualBackupPath, manualBackupContent, "utf-8");
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      for (let version = 1; version <= 6; version += 1) {
        await maintainConfigBackups(configPath, fs);
        await writeVersion(version);
      }

      await expect(readVersion()).resolves.toBe(6);
      await expect(readVersion(".bak")).resolves.toBe(5);
      await expect(readVersion(".bak.1")).resolves.toBe(4);
      await expect(readVersion(".bak.2")).resolves.toBe(3);
      await expect(readVersion(".bak.3")).resolves.toBe(2);
      await expect(readVersion(".bak.4")).resolves.toBe(1);
      await expectPathMissing(`${configPath}.bak.5`);
      await expect(readVersion(".pre-update")).resolves.toBe(0);
      await expect(fs.readFile(manualBackupPath, "utf-8")).resolves.toBe(manualBackupContent);
    });
  });

  it("maintainConfigBackups composes rotate/copy/harden flow", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      await fs.writeFile(configPath, JSON.stringify({ token: "secret" }), { mode: 0o600 });
      await fs.writeFile(`${configPath}.bak`, "previous", { mode: 0o644 });

      await maintainConfigBackups(configPath, fs);

      // A new primary backup is created from the current config.
      await expect(fs.readFile(`${configPath}.bak`, "utf-8")).resolves.toBe(
        JSON.stringify({ token: "secret" }),
      );
      // Prior primary backup gets rotated into ring slot 1.
      await expect(fs.readFile(`${configPath}.bak.1`, "utf-8")).resolves.toBe("previous");
      // Windows cannot validate POSIX chmod bits, but all other compose assertions
      // should still run there.
      if (!IS_WINDOWS) {
        const primaryBackupStat = await fs.stat(`${configPath}.bak`);
        expectPosixMode(primaryBackupStat.mode, 0o600);
      }
    });
  });

  it.each(["unlink", "rename", "copyFile", "chmod"] as const)(
    "stops backup maintenance when executor authority ends after %s",
    async (revokeAfter) => {
      await withTempHome(async (home) =>
        withConfigExecutor(home, async (assertCurrent, revoke) => {
          const configPath = resolveConfigPathFromTempState();
          const raw = '{"gateway":{"mode":"local","port":18789}}\n';
          await fs.writeFile(configPath, raw);
          const backupPaths = ["", ".1", ".2", ".3", ".4"].map(
            (suffix) => `${configPath}.bak${suffix}`,
          );
          for (const [index, backupPath] of backupPaths.entries()) {
            await fs.writeFile(backupPath, `recovery-${index}`, { mode: 0o644 });
          }
          const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
          const readBackups = () =>
            Promise.all(
              backupPaths.map(async (backupPath) => {
                try {
                  return {
                    raw: await fs.readFile(backupPath, "utf8"),
                    mode: (await fs.stat(backupPath)).mode,
                  };
                } catch (error) {
                  if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                    throw error;
                  }
                  return null;
                }
              }),
            );
          let atRevocation: Awaited<ReturnType<typeof readBackups>> | undefined;
          const mutationsAfterRevocation: string[] = [];
          const afterMutation = async (operation: typeof revokeAfter, target: fsNode.PathLike) => {
            if (!String(target).includes(".bak")) {
              return;
            }
            if (atRevocation) {
              mutationsAfterRevocation.push(operation);
            } else if (operation === revokeAfter) {
              revoke();
              atRevocation = await readBackups();
            }
          };
          const io = createConfigIO({
            env,
            homedir: () => home,
            observe: false,
            pluginValidation: "skip",
            fs: {
              ...fsNode,
              promises: {
                ...fsNode.promises,
                unlink: async (target) => {
                  await fs.unlink(target);
                  await afterMutation("unlink", target);
                },
                rename: async (source, destination) => {
                  await fs.rename(source, destination);
                  await afterMutation("rename", destination);
                },
                copyFile: async (source, destination, mode) => {
                  await fs.copyFile(source, destination, mode);
                  await afterMutation("copyFile", destination);
                },
                chmod: async (target, mode) => {
                  await fs.chmod(target, mode);
                  await afterMutation("chmod", target);
                },
              },
            },
          });
          const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();

          await expect(
            io.writeConfigFile(
              { gateway: { mode: "local", port: 19001 } },
              { ...writeOptions, baseSnapshot: snapshot, assertCurrent },
            ),
          ).rejects.toThrow(/executor ownership is no longer current|source ownership changed/);

          expect(atRevocation).toBeDefined();
          expect(mutationsAfterRevocation).toEqual([]);
          expect(await readBackups()).toEqual(atRevocation);
          expect(await fs.readFile(configPath, "utf8")).toBe(raw);
        }),
      );
    },
  );

  it("createPreUpdateConfigSnapshot writes .pre-update outside rotation ring", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const content = JSON.stringify({ plugins: { installs: ["matrix"] } });
      await fs.writeFile(configPath, content, { mode: 0o600 });

      const { existsSync } = await import("node:fs");
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });

      const snapshotPath = `${configPath}.pre-update`;
      await expectRegularFile(snapshotPath);
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(content);
      if (!IS_WINDOWS) {
        const stat = await fs.stat(snapshotPath);
        expectPosixMode(stat.mode, 0o600);
      }
    });
  });

  it("createPreUpdateConfigSnapshot replaces a preexisting snapshot once per process", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const stale = JSON.stringify({ snapshot: "stale" });
      const current = JSON.stringify({ snapshot: "current" });
      const second = JSON.stringify({ snapshot: "second" });
      const snapshotPath = `${configPath}.pre-update`;
      await fs.writeFile(configPath, current, { mode: 0o600 });
      await fs.writeFile(snapshotPath, stale, { mode: 0o600 });

      const { existsSync } = await import("node:fs");
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(current);

      // Later writes in the same update attempt should not replace the first snapshot.
      await fs.writeFile(configPath, second);
      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });
      await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(current);
    });
  });

  it("createPreUpdateConfigSnapshot is a no-op when config does not exist", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const { existsSync } = await import("node:fs");

      await createPreUpdateConfigSnapshot({
        configPath,
        fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
      });

      await expectPathMissing(`${configPath}.pre-update`);
    });
  });

  it("retries snapshot after transient read and write errors (#105431)", async () => {
    await withTempHome(async () => {
      const content = JSON.stringify({ plugins: { installs: ["slack"] } });
      const { existsSync } = await import("node:fs");
      const rejectingReadFile = (async () => {
        throw new Error("EIO: transient read error");
      }) as typeof fs.readFile;
      const rejectingWriteFile = (async () => {
        throw new Error("ENOSPC: transient write error");
      }) as typeof fs.writeFile;

      for (const failingOperation of ["read", "write"] as const) {
        const configPath = `${resolveConfigPathFromTempState()}.${failingOperation}`;
        await fs.writeFile(configPath, content, { mode: 0o600 });

        await createPreUpdateConfigSnapshot({
          configPath,
          fs: {
            readFile: failingOperation === "read" ? rejectingReadFile : fs.readFile,
            writeFile: failingOperation === "write" ? rejectingWriteFile : fs.writeFile,
            existsSync,
          },
        });
        await expectPathMissing(`${configPath}.pre-update`);

        await createPreUpdateConfigSnapshot({
          configPath,
          fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
        });

        const snapshotPath = `${configPath}.pre-update`;
        await expectRegularFile(snapshotPath);
        await expect(fs.readFile(snapshotPath, "utf-8")).resolves.toBe(content);
      }
    });
  });
});
