// Covers the canonical reread that follows a committed config write.
import fsNode from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  releaseUpdateCommandPreflightForHandoff,
  withUpdateCommandExecutor,
} from "../cli/update-cli/update-command-executor.js";
import {
  captureManagedUpdateLeaseDatabaseIdentity,
  createManagedHandoffLeaseDatabase,
} from "../infra/update-managed-service-handoff-database.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { readConfigSnapshotAuditRecord } from "./config-journal-snapshot.js";
import { listConfigAuditRecordsForTests } from "./io.audit.test-support.js";
import { createConfigIO } from "./io.factory.js";
import { readConfigFileSnapshotForWrite, writeConfigFile } from "./io.runtime.js";
import type { ConfigWriteOptions } from "./io.types.js";
import { replaceConfigFile } from "./mutate.js";
import { ConfigMutationConflictError } from "./mutation-conflict.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
  type RuntimeConfigSnapshotRefreshHandler,
} from "./runtime-snapshot.js";
import { withTempHome } from "./test-helpers.js";
import { withConfigWriteLock } from "./write-lock.js";

async function withConfigExecutor(
  home: string,
  operation: (assertCurrent: () => void, revoke: () => void) => Promise<void>,
) {
  const root = path.join(await fs.realpath(home), "package");
  await fs.mkdir(root);
  const databasePath = path.join(home, "control", "managed-update-handoffs.sqlite");
  createManagedHandoffLeaseDatabase(databasePath)(true, () => undefined);
  await withUpdateCommandExecutor(
    "config-compensation-fence",
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

describe("writeConfigFile canonical reread", () => {
  afterEach(() => {
    setRuntimeConfigSnapshotRefreshHandler(null);
    clearRuntimeConfigSnapshot();
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it("preserves committed source provenance when the post-write reread is invalid", async () => {
    await withTempHome(async (home) => {
      const configPath = path.join(home, ".openclaw", "openclaw.json");
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      const initialConfig = {
        gateway: { mode: "local", port: 18789 },
        agents: { entries: { main: {} }, defaults: { compaction: {} } },
      };
      await fs.writeFile(configPath, `${JSON.stringify(initialConfig, null, 2)}\n`, "utf-8");

      // Simulate a concurrent edit racing the commit: after the write renames the
      // new config into place, every subsequent sync read sees corrupt content,
      // so the canonical reread parses invalid.
      let corrupted = false;
      const realRename = fsNode.promises.rename.bind(fsNode.promises);
      vi.spyOn(fsNode.promises, "rename").mockImplementation(async (from, to) => {
        await realRename(from, to);
        if (to === configPath) {
          corrupted = true;
        }
      });
      const realReadFileSync = fsNode.readFileSync.bind(fsNode);
      vi.spyOn(fsNode, "readFileSync").mockImplementation(
        (target, options?: BufferEncoding | fsNode.ReadFileSyncOptions | null) => {
          if (corrupted && target === configPath) {
            return "{ definitely not json";
          }
          return realReadFileSync(
            target,
            typeof options === "string" ? { encoding: options } : (options ?? {}),
          );
        },
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const preflight = vi.fn<NonNullable<RuntimeConfigSnapshotRefreshHandler["preflight"]>>(
        ({ sourceConfig }) => ({ sourceConfig }),
      );
      const refresh = vi.fn<RuntimeConfigSnapshotRefreshHandler["refresh"]>(async () => true);
      setRuntimeConfigSnapshotRefreshHandler({ preflight, refresh });

      await withEnvAsync(
        { OPENCLAW_CONFIG_PATH: configPath, OPENCLAW_TEST_FAST: "1" },
        async () => {
          const { snapshot } = await readConfigFileSnapshotForWrite();
          expect(snapshot.config.agents?.defaults?.compaction?.mode).toBe("safeguard");
          setRuntimeConfigSnapshot(snapshot.config, snapshot.sourceConfig);
          await writeConfigFile({
            ...snapshot.config,
            gateway: { mode: "local", port: 19001 },
          });
        },
      );

      const persisted: unknown = JSON.parse(await fs.readFile(configPath, "utf-8"));
      expect(persisted).toHaveProperty("agents.defaults.compaction", {});
      expect(preflight).toHaveBeenCalledExactlyOnceWith({ sourceConfig: persisted });
      expect(refresh).toHaveBeenCalledExactlyOnceWith({
        sourceConfig: persisted,
        preflightResult: { sourceConfig: persisted },
      });
      expect(
        warn.mock.calls.some(([line]) =>
          String(line).includes("canonical reread after write was invalid"),
        ),
      ).toBe(true);
    });
  });

  it.each([false, true].flatMap((existed) => [false, true].map((revoke) => ({ existed, revoke }))))(
    "rechecks compensation authority after reading the committed file (existed=$existed, revoke=$revoke)",
    async ({ existed, revoke }) => {
      await withTempHome(async (home) =>
        withConfigExecutor(home, async (assertCurrent, revokeExecutor) => {
          const configPath = path.join(home, ".openclaw", "openclaw.json");
          await fs.mkdir(path.dirname(configPath), { recursive: true });
          const original = '{"gateway":{"mode":"local","port":18789}}\n';
          if (existed) {
            await fs.writeFile(configPath, original);
          }
          const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
          const io = createConfigIO({
            env,
            observe: false,
            pluginValidation: "skip",
            homedir: () => home,
          });
          const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
          const auditSnapshot = () =>
            readConfigSnapshotAuditRecord({ env, homedir: () => home, configPath });
          const beforeAuditSnapshot = auditSnapshot();
          let compensating = false;
          let committedRaw: string | Buffer | undefined;
          const readFile = fsNode.promises.readFile.bind(fsNode.promises);
          vi.spyOn(fsNode.promises, "readFile").mockImplementation(async (...args) => {
            const raw = await readFile(...args);
            if (compensating && args[0] === configPath && committedRaw === undefined) {
              committedRaw = raw;
              if (revoke) {
                revokeExecutor();
              }
            }
            return raw;
          });
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: () => undefined,
            refresh: () => {
              compensating = true;
              throw new Error("runtime activation refused");
            },
          });

          const failure = await writeConfigFile(
            { gateway: { mode: "local", port: 19001 } },
            {
              ...writeOptions,
              assertCurrent,
              baseSnapshot: snapshot,
              observe: false,
              skipPluginValidation: true,
            },
          ).catch((error: unknown) => error);
          expect(failure).toBeInstanceOf(Error);
          expect(failure).toHaveProperty(
            "message",
            expect.stringMatching(/runtime snapshot refresh failed/),
          );

          expect(committedRaw).toBeDefined();
          if (revoke) {
            expect(await fs.readFile(configPath, "utf8")).toBe(committedRaw);
            expect(JSON.parse(String(committedRaw)).gateway.port).toBe(19001);
          } else {
            expect(failure).not.toHaveProperty(
              "message",
              expect.stringContaining("Rollback failed"),
            );
            expect(auditSnapshot()).toEqual(beforeAuditSnapshot);
            if (existed) {
              expect(await fs.readFile(configPath, "utf8")).toBe(original);
            } else {
              await expect(fs.stat(configPath)).rejects.toMatchObject({ code: "ENOENT" });
            }
          }
        }),
      );
    },
  );

  it.each([
    { writer: "direct", authority: "ordinary" },
    { writer: "runtime", authority: "ordinary" },
    { writer: "mutation", authority: "ordinary" },
    { writer: "runtime", authority: "explicit" },
    { writer: "runtime", authority: "ambient" },
  ] as const)(
    "preserves the compensation fallback policy for $writer writes with $authority authority",
    async ({ writer, authority }) => {
      await withTempHome(async (home) => {
        const configPath = path.join(home, ".openclaw", "openclaw.json");
        await fs.mkdir(path.dirname(configPath), { recursive: true });
        const original = '{"gateway":{"mode":"local","port":18789}}\n';
        await fs.writeFile(configPath, original);
        const env = { ...process.env, OPENCLAW_CONFIG_PATH: configPath };
        const io = createConfigIO({ env, observe: false, pluginValidation: "skip" });
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
        const priorAudit =
          writer === "direct"
            ? listConfigAuditRecordsForTests({ env: io.env, homedir: () => home })
            : undefined;
        let committed = false;
        let compensationDenied = false;
        const rename = fsNode.promises.rename.bind(fsNode.promises);
        vi.spyOn(fsNode.promises, "rename").mockImplementation(async (source, destination) => {
          if (destination === configPath && committed) {
            compensationDenied = true;
            throw Object.assign(new Error("compensation rename denied"), { code: "EPERM" });
          }
          await rename(source, destination);
          if (destination === configPath) {
            committed = true;
            if (writer === "direct") {
              env.OPENCLAW_CONFIG_PATH = `${configPath}.replacement`;
            }
          }
        });
        if (writer !== "direct") {
          setRuntimeConfigSnapshotRefreshHandler({
            preflight: () => undefined,
            refresh: () => {
              throw new Error("runtime activation refused");
            },
          });
        }
        const write = async (assertCurrent?: () => void) => {
          const options: ConfigWriteOptions = {
            ...writeOptions,
            baseSnapshot: snapshot,
            observe: false,
            skipPluginValidation: true,
            ...(assertCurrent ? { assertCurrent } : {}),
          };
          const nextConfig = { gateway: { mode: "local" as const, port: 19001 } };
          const pending =
            writer === "direct"
              ? io.writeConfigFile(nextConfig, options)
              : writer === "runtime"
                ? writeConfigFile(nextConfig, options)
                : replaceConfigFile({ snapshot, writeOptions: options, nextConfig });
          await expect(pending).rejects.toThrow(
            writer === "direct" ? /config path changed/ : /runtime snapshot refresh failed/,
          );
          if (writer === "direct") {
            await expect(pending).rejects.toBeInstanceOf(ConfigMutationConflictError);
            await expect(pending).rejects.toMatchObject({
              message: "config path changed since last load",
              retryable: false,
            });
            expect(listConfigAuditRecordsForTests({ env: io.env, homedir: () => home })).toEqual(
              priorAudit,
            );
          }
        };
        if (authority === "ordinary") {
          await write();
        } else {
          await withConfigExecutor(home, async (assertCurrent) => {
            if (authority === "explicit") {
              await write(assertCurrent);
            } else {
              await withConfigWriteLock(configPath, () => write(), env, assertCurrent);
            }
          });
        }
        expect(compensationDenied).toBe(true);
        if (authority === "ordinary") {
          expect(await fs.readFile(configPath, "utf8")).toBe(original);
        } else {
          expect(JSON.parse(await fs.readFile(configPath, "utf8")).gateway.port).toBe(19001);
        }
      });
    },
  );
});
