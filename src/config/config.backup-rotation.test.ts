// Covers config backup rotation limits and snapshot behavior.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useConfigCliIntegrationHarness } from "../cli/config-cli.integration.test-harness.js";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../infra/update-managed-service-handoff-database.js";
import { createPreUpdateConfigSnapshot } from "./backup-rotation.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { createConfigIO } from "./io.factory.js";
import { withTempHome } from "./test-helpers.js";

const { runRegisteredConfigCommand, withConfigFileHarness } = useConfigCliIntegrationHarness();

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
  it("openclaw config set keeps five recovery points and preserves manual and pre-update backups", async () => {
    const original = '{"gateway":{"mode":"local","port":19000}}\n';
    await withConfigFileHarness(
      "openclaw-config-backup-ring-",
      original,
      async ({ configPath }) => {
        const readPort = async (suffix = "") => {
          const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
          return (JSON.parse(raw) as { gateway: { port: number } }).gateway.port;
        };
        const { existsSync } = await import("node:fs");
        const manualBackupPath = `${configPath}.bak.20260808`;
        const manualBackupContent = '{"gateway":{"mode":"local","port":18000}}\n';

        await fs.writeFile(manualBackupPath, manualBackupContent, "utf-8");
        await createPreUpdateConfigSnapshot({
          configPath,
          fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
        });
        for (let version = 1; version <= 6; version += 1) {
          await runRegisteredConfigCommand([
            "config",
            "set",
            "gateway.port",
            String(19000 + version),
          ]);
        }

        await expect(readPort()).resolves.toBe(19006);
        await expect(readPort(".bak")).resolves.toBe(19005);
        await expect(readPort(".bak.1")).resolves.toBe(19004);
        await expect(readPort(".bak.2")).resolves.toBe(19003);
        await expect(readPort(".bak.3")).resolves.toBe(19002);
        await expect(readPort(".bak.4")).resolves.toBe(19001);
        await expectPathMissing(`${configPath}.bak.5`);
        await expect(fs.readFile(`${configPath}.pre-update`, "utf-8")).resolves.toBe(original);
        await expect(fs.readFile(manualBackupPath, "utf-8")).resolves.toBe(manualBackupContent);
      },
    );
  });

  it.each(["root", "include"])(
    "openclaw config set preserves original %s bytes in private recovery backups",
    async (location) => {
      const includeRaw = '{"level":"info"}\n';
      const rootRaw =
        JSON.stringify({
          gateway: { mode: "local" },
          logging: location === "include" ? { $include: "logging.json" } : { level: "info" },
        }) + "\n";
      await withConfigFileHarness(
        "openclaw-config-private-backup-",
        rootRaw,
        async ({ configPath, tempDir }) => {
          const target = location === "include" ? path.join(tempDir, "logging.json") : configPath;
          const original = location === "include" ? includeRaw : rootRaw;
          await fs.writeFile(target, original, { mode: 0o600 });
          const previousBackup = '{"level":"warn"}\n';
          await fs.writeFile(`${target}.bak`, previousBackup, { mode: 0o644 });

          await runRegisteredConfigCommand(["config", "set", "logging.level", "debug"]);

          const saved = JSON.parse(await fs.readFile(target, "utf8"));
          expect(location === "include" ? saved.level : saved.logging.level).toBe("debug");
          await expect(fs.readFile(`${target}.bak`, "utf-8")).resolves.toBe(original);
          await expect(fs.readFile(`${target}.bak.1`, "utf-8")).resolves.toBe(previousBackup);
          expectPosixMode((await fs.stat(`${target}.bak`)).mode, 0o600);
          expectPosixMode((await fs.stat(`${target}.bak.1`)).mode, 0o600);
          if (location === "include") {
            await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
          }
        },
      );
    },
  );

  it.skipIf(IS_WINDOWS).each(["symlink", "hardlink"])(
    "openclaw config set leaves an external file unchanged through an include backup %s",
    async (linkKind) => {
      const rootRaw = '{"gateway":{"mode":"local"},"logging":{"$include":"logging.json"}}\n';
      await withConfigFileHarness(
        "openclaw-config-linked-backup-",
        rootRaw,
        async ({ configPath, tempDir }) => {
          const includePath = path.join(tempDir, "logging.json");
          const externalPath = path.join(tempDir, "external.txt");
          const externalRaw = "external file must stay unchanged\n";
          await fs.writeFile(includePath, '{"level":"info"}\n');
          await fs.writeFile(externalPath, externalRaw, { mode: 0o644 });
          const backupPath = `${includePath}.bak`;
          await (linkKind === "symlink" ? fs.symlink : fs.link)(externalPath, backupPath);

          await runRegisteredConfigCommand(["config", "set", "logging.level", "debug"]);

          expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({ level: "debug" });
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
          await expect(fs.readFile(externalPath, "utf8")).resolves.toBe(externalRaw);
          expectPosixMode((await fs.stat(externalPath)).mode, 0o644);
          await expect(fs.readFile(backupPath, "utf8")).resolves.toBe(externalRaw);
          await expectPathMissing(`${backupPath}.1`);
        },
      );
    },
  );

  it.each(["unlink", "rename", "fchmod"] as const)(
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
            backupPaths.map((backupPath) => {
              try {
                return {
                  raw: fsNode.readFileSync(backupPath, "utf8"),
                  mode: fsNode.statSync(backupPath).mode,
                };
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
                  throw error;
                }
                return null;
              }
            });
          let atRevocation: Awaited<ReturnType<typeof readBackups>> | undefined;
          const openBackupPaths = new Map<number, fsNode.PathLike>();
          const mutationsAfterRevocation: string[] = [];
          const afterMutation = (operation: typeof revokeAfter, target: fsNode.PathLike) => {
            if (!String(target).includes(".bak")) {
              return;
            }
            if (atRevocation) {
              mutationsAfterRevocation.push(operation);
            } else if (operation === revokeAfter) {
              revoke();
              atRevocation = readBackups();
            }
          };
          const io = createConfigIO({
            env,
            homedir: () => home,
            observe: false,
            pluginValidation: "skip",
            fs: {
              ...fsNode,
              openSync: (target, flags, mode) => {
                const fd = fsNode.openSync(target, flags, mode);
                if (backupPaths.includes(String(target))) {
                  openBackupPaths.set(fd, target);
                }
                return fd;
              },
              closeSync: (fd) => {
                fsNode.closeSync(fd);
                openBackupPaths.delete(fd);
              },
              unlinkSync: (target) => {
                fsNode.unlinkSync(target);
                afterMutation("unlink", target);
              },
              renameSync: (source, destination) => {
                fsNode.renameSync(source, destination);
                afterMutation("rename", destination);
              },
              fchmodSync: (fd, mode) => {
                fsNode.fchmodSync(fd, mode);
                const target = openBackupPaths.get(fd);
                if (target !== undefined) {
                  afterMutation("fchmod", target);
                }
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
          expect(readBackups()).toEqual(atRevocation);
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
