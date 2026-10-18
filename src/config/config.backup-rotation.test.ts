import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useConfigCliIntegrationHarness } from "../cli/config-cli.integration.test-harness.js";
import { createPreUpdateConfigSnapshot } from "./backup-rotation.js";
import { withExecutor } from "./config-executor.test-support.js";
import {
  expectPosixMode,
  IS_WINDOWS,
  resolveConfigPathFromTempState,
} from "./config.backup-rotation.test-helpers.js";
import { createConfigIO } from "./io.factory.js";
import { withTempHome } from "./test-helpers.js";

const { runRegisteredConfigCommand: run, withConfigFileHarness: withConfig } =
  useConfigCliIntegrationHarness();
const set = (key: string, value: string) => run(["config", "set", key, value]);
async function expectFile(file: string, raw: string, mode?: number) {
  await expect(fs.readFile(file, "utf8")).resolves.toBe(raw);
  if (mode !== undefined) {
    expectPosixMode((await fs.stat(file)).mode, mode);
  }
}

async function expectPathMissing(filePath: string): Promise<void> {
  await expect(fs.stat(filePath)).rejects.toMatchObject({ code: "ENOENT" });
}

const createSnapshot = (
  configPath: string,
  overrides: Partial<Parameters<typeof createPreUpdateConfigSnapshot>[0]["fs"]> = {},
) =>
  createPreUpdateConfigSnapshot({
    configPath,
    fs: {
      writeFile: fs.writeFile,
      readFile: fs.readFile,
      existsSync: fsNode.existsSync,
      ...overrides,
    },
  });

describe("config backup rotation", () => {
  it("openclaw config set keeps five recovery points and preserves manual and pre-update backups", async () => {
    const original = '{"gateway":{"mode":"local","port":19000}}\n';
    await withConfig("openclaw-config-backup-ring-", original, async ({ configPath }) => {
      const readPort = async (suffix = "") => {
        const raw = await fs.readFile(`${configPath}${suffix}`, "utf-8");
        return (JSON.parse(raw) as { gateway: { port: number } }).gateway.port;
      };
      const manualBackupPath = `${configPath}.bak.20260808`;
      const manualBackupContent = '{"gateway":{"mode":"local","port":18000}}\n';

      await fs.writeFile(manualBackupPath, manualBackupContent, "utf-8");
      await createSnapshot(configPath);
      for (let version = 1; version <= 6; version += 1) {
        await set("gateway.port", String(19000 + version));
        if (version === 1) {
          await expectFile(`${configPath}.bak`, original);
        }
      }

      await expect(
        Promise.all(["", ".bak", ".bak.1", ".bak.2", ".bak.3", ".bak.4"].map(readPort)),
      ).resolves.toEqual([19006, 19005, 19004, 19003, 19002, 19001]);
      for (const suffix of [".bak", ".bak.1"]) {
        expectPosixMode((await fs.stat(`${configPath}${suffix}`)).mode, 0o600);
      }
      await expectPathMissing(`${configPath}.bak.5`);
      await expectFile(`${configPath}.pre-update`, original, 0o600);
      await expectFile(manualBackupPath, manualBackupContent);
    });
  });

  it("openclaw config set preserves original include bytes in private recovery backups", async () => {
    const original = '{"level":"info"}\n';
    const rootRaw = '{"gateway":{"mode":"local"},"logging":{"$include":"logging.json"}}\n';
    await withConfig(
      "openclaw-config-private-backup-",
      rootRaw,
      async ({ configPath, tempDir }) => {
        const target = path.join(tempDir, "logging.json");
        await fs.writeFile(target, original, { mode: 0o600 });
        const previousBackup = '{"level":"warn"}\n';
        await fs.writeFile(`${target}.bak`, previousBackup, { mode: 0o644 });

        await set("logging.level", "debug");

        const saved = JSON.parse(await fs.readFile(target, "utf8"));
        expect(saved.level).toBe("debug");
        await expectFile(`${target}.bak`, original, 0o600);
        await expectFile(`${target}.bak.1`, previousBackup, 0o600);
        await expectFile(configPath, rootRaw);
      },
    );
  });

  it.skipIf(IS_WINDOWS).each(["symlink", "hardlink"])(
    "openclaw config set leaves an external file unchanged through an include backup %s",
    async (linkKind) => {
      const rootRaw = '{"gateway":{"mode":"local"},"logging":{"$include":"logging.json"}}\n';
      await withConfig(
        "openclaw-config-linked-backup-",
        rootRaw,
        async ({ configPath, tempDir }) => {
          const includePath = path.join(tempDir, "logging.json");
          const externalPath = path.join(tempDir, "external.txt");
          const externalRaw = "external file must stay unchanged\n";
          await fs.writeFile(includePath, '{"level":"info"}\n');
          await fs.writeFile(externalPath, externalRaw, { mode: 0o644 });
          // Establish the fixture mode independently of the process umask.
          await fs.chmod(externalPath, 0o644);
          expectPosixMode((await fs.stat(externalPath)).mode, 0o644);
          const backupPath = `${includePath}.bak`;
          await (linkKind === "symlink" ? fs.symlink : fs.link)(externalPath, backupPath);

          await set("logging.level", "debug");

          expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({ level: "debug" });
          await expectFile(configPath, rootRaw);
          await expectFile(externalPath, externalRaw, 0o644);
          await expectFile(backupPath, externalRaw);
          await expectPathMissing(`${backupPath}.1`);
        },
      );
    },
  );

  it.each(["unlink", "rename", "fchmod"] as const)(
    "stops backup maintenance when executor authority ends after %s",
    async (revokeAfter) => {
      await withTempHome(async (home) =>
        withExecutor(home, "config-backup-fence", async (assertCurrent, revoke) => {
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

  it("createPreUpdateConfigSnapshot replaces a preexisting snapshot once per process", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      const stale = JSON.stringify({ snapshot: "stale" });
      const current = JSON.stringify({ snapshot: "current" });
      const second = JSON.stringify({ snapshot: "second" });
      const snapshotPath = `${configPath}.pre-update`;
      await fs.writeFile(configPath, current, { mode: 0o600 });
      await fs.writeFile(snapshotPath, stale, { mode: 0o600 });

      await createSnapshot(configPath);
      await expectFile(snapshotPath, current);

      // Later writes in the same update attempt should not replace the first snapshot.
      await fs.writeFile(configPath, second);
      await createSnapshot(configPath);
      await expectFile(snapshotPath, current);
    });
  });

  it("createPreUpdateConfigSnapshot is a no-op when config does not exist", async () => {
    await withTempHome(async () => {
      const configPath = resolveConfigPathFromTempState();
      await createSnapshot(configPath);

      await expectPathMissing(`${configPath}.pre-update`);
    });
  });

  it("retries snapshot after transient read and write errors (#105431)", async () => {
    await withTempHome(async () => {
      const content = JSON.stringify({ plugins: { installs: ["slack"] } });
      const rejectingReadFile = (async () => {
        throw new Error("EIO: transient read error");
      }) as typeof fs.readFile;
      const rejectingWriteFile = (async () => {
        throw new Error("ENOSPC: transient write error");
      }) as typeof fs.writeFile;

      for (const failingOperation of ["read", "write"] as const) {
        const configPath = `${resolveConfigPathFromTempState()}.${failingOperation}`;
        await fs.writeFile(configPath, content, { mode: 0o600 });

        await createSnapshot(configPath, {
          readFile: failingOperation === "read" ? rejectingReadFile : fs.readFile,
          writeFile: failingOperation === "write" ? rejectingWriteFile : fs.writeFile,
        });
        await expectPathMissing(`${configPath}.pre-update`);

        await createSnapshot(configPath);

        const snapshotPath = `${configPath}.pre-update`;
        expect((await fs.stat(snapshotPath)).isFile()).toBe(true);
        await expectFile(snapshotPath, content);
      }
    });
  });
});
