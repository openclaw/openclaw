import fs from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { runPluginInstallCommand } from "../cli/plugins-install-command.js";
import { runWithLocalPluginState } from "../cli/plugins-local-state.js";
import {
  installPackageDir,
  requestDeferredPackageDirInstall,
  resolvePackageDirInstallTransaction,
} from "../infra/install-package-dir.js";
import { withPluginLifecycleLease } from "../plugins/plugin-lifecycle-lease.js";
import type { RuntimeEnv } from "../runtime.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeStateDatabaseForTest } from "../test-utils/database-cleanup.js";
import { withEnvAsync } from "../test-utils/env.js";
import { writeHookFixture } from "./hook-fixture.test-support.js";
import { stageHookInstall } from "./install-record-transaction.js";
import * as hookInstaller from "./install.js";
import { readHookInstalls, readHookInstallsAsync, recordHookInstall } from "./installs.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(async () => {
    await closeStateDatabaseForTest();
    vi.restoreAllMocks();
    cleanup();
  });
});

const readText = (file: string) => fs.readFileSync(file, "utf8");
const readPayload = (dir: string) => readText(join(dir, "payload.txt"));
const readEntry = (file: string) =>
  JSON.parse(readText(file)).hooks?.internal?.entries?.["command-audit"]?.enabled;

type InstallOptions = {
  beforePersistentApply?: () => void;
  log?: RuntimeEnv["log"];
};

it("reads newly recorded packs after a worker read", async () => {
  const stateDir = tempDirs.make("openclaw-hook-installs-");
  const options = { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
  recordHookInstall({ hookId: "alpha", source: "npm" }, options);
  expect(await readHookInstallsAsync(options)).toMatchObject({ alpha: { source: "npm" } });

  recordHookInstall({ hookId: "beta", source: "path" }, options);
  const expected = { alpha: { source: "npm" }, beta: { source: "path" } };
  expect(await readHookInstallsAsync(options)).toMatchObject(expected);
  expect(readHookInstalls(options)).toMatchObject(expected);
});

async function withHookInstallFixture(
  mode: "install" | "update" | "link",
  run: (fixture: {
    configPath: string;
    sourceDir: string;
    targetDir: string;
    payloadTransaction: ReturnType<typeof resolvePackageDirInstallTransaction>;
    persist: (overrides: InstallOptions) => Promise<void>;
  }) => Promise<void>,
) {
  const root = tempDirs.make("openclaw-hook-commit-");
  const stateDir = join(root, "state");
  const configPath = join(stateDir, "openclaw.json");
  const sourceDir = join(root, "source");
  const targetDir = mode === "link" ? sourceDir : join(stateDir, "hooks", "alpha");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(join(sourceDir, "payload.txt"), "candidate");
  fs.writeFileSync(
    join(sourceDir, "package.json"),
    JSON.stringify({ name: "alpha", version: "2.0.0", openclaw: { hooks: ["./command-audit"] } }),
  );
  writeHookFixture(
    join(sourceDir, "command-audit"),
    '---\nname: command-audit\ndescription: "Fixture hook"\n---\n',
    "export default () => {};\n",
    "handler.js",
  );
  fs.writeFileSync(configPath, "{}\n");
  await withEnvAsync(
    { OPENCLAW_HOME: root, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath },
    async () =>
      runWithLocalPluginState("hook install fixture", () =>
        withPluginLifecycleLease({}, async () => {
          if (mode === "update") {
            fs.mkdirSync(targetDir, { recursive: true });
            fs.writeFileSync(join(targetDir, "payload.txt"), "previous");
            writeConfigMachineState("hooks.internal.installs", {
              alpha: { source: "path", installPath: targetDir, version: "1.0.0" },
            });
          }
          const result =
            mode === "link"
              ? undefined
              : await installPackageDir(
                  requestDeferredPackageDirInstall({
                    sourceDir,
                    targetDir,
                    mode,
                    timeoutMs: 30_000,
                    copyErrorPrefix: "fixture copy failed",
                    hasDeps: false,
                    depsLogMessage: "unused",
                  }),
                );
          if (result && !result.ok) {
            throw new Error(result.error);
          }
          const payloadTransaction = result
            ? resolvePackageDirInstallTransaction(result)
            : undefined;
          let readyForPersistence = false;
          // Retain the real installer's payload transaction; this suite owns the later
          // record/config commit rather than repeating artifact discovery and copying.
          vi.spyOn(hookInstaller, "installHooksFromPath").mockImplementation(async () => {
            readyForPersistence = true;
            return {
              ...result,
              ok: true,
              hookPackId: "alpha",
              hooks: ["command-audit"],
              targetDir,
              version: "2.0.0",
            };
          });
          await run({
            configPath,
            sourceDir,
            targetDir,
            payloadTransaction,
            async persist(overrides) {
              const errors: string[] = [];
              await runPluginInstallCommand({
                raw: sourceDir,
                opts: { force: true, acceptCapabilities: true, link: mode === "link" },
                allowInstallPolicyWarningPrompt: false,
                beforePersistentApply() {
                  if (readyForPersistence) {
                    overrides.beforePersistentApply?.();
                  }
                },
                runtime: {
                  log: overrides.log ?? (() => {}),
                  error: (...messages) => errors.push(messages.map(String).join(" ")),
                  exit: () => {
                    throw new Error(errors.at(-1) ?? "unexpected exit");
                  },
                },
              });
            },
          });
        }),
      ),
  );
}

it.each(
  (["install", "update", "link"] as const).flatMap((mode) =>
    (["before record", "after record", "after config"] as const).map((phase) => ({ mode, phase })),
  ),
)("compensates $mode cancellation $phase without touching its source", async ({ mode, phase }) =>
  withHookInstallFixture(mode, async ({ configPath, sourceDir, targetDir, persist }) => {
    const previousRecords = readConfigMachineState("hooks.internal.installs");
    const previousConfig = readText(configPath);
    let closed = phase === "before record";

    await expect(
      persist({
        beforePersistentApply() {
          if (phase === "after config") {
            closed = Boolean(readEntry(configPath));
          }
          if (closed) {
            throw new Error("hook authority closed");
          }
          if (phase === "after record") {
            queueMicrotask(() => {
              closed = true;
            });
          }
        },
      }),
    ).rejects.toThrow("hook authority closed");

    expect(readConfigMachineState("hooks.internal.installs")).toEqual(previousRecords);
    expect(readText(configPath)).toBe(previousConfig);
    expect(readPayload(sourceDir)).toBe("candidate");
    if (mode === "install") {
      expect(fs.existsSync(targetDir)).toBe(false);
    } else {
      expect(readPayload(targetDir)).toBe(mode === "update" ? "previous" : "candidate");
    }
  }),
);

it("refuses compensation after its lifecycle lease has been replaced", async () => {
  const root = tempDirs.make("openclaw-hook-lease-");
  const payload = join(root, "payload.txt");
  fs.writeFileSync(payload, "successor payload");
  await withEnvAsync({ OPENCLAW_STATE_DIR: join(root, "state") }, async () => {
    const transaction = await withPluginLifecycleLease({}, async (lease) => {
      return await stageHookInstall({
        update: { hookId: "alpha", source: "path", installPath: root },
        lease,
        payloadTransaction: {
          async commit() {},
          async rollback() {
            fs.unlinkSync(payload);
          },
        },
      });
    });
    await withPluginLifecycleLease({}, async () => {
      const successor = readHookInstalls();
      await expect(transaction.rollback()).rejects.toThrow("lost");
      expect(readHookInstalls()).toEqual(successor);
      expect(fs.readFileSync(payload, "utf8")).toBe("successor payload");
    });
  });
});

it.each(["unrelated", "replacement"] as const)(
  "preserves a %s record written before compensation",
  async (writer) => {
    await withHookInstallFixture("install", async ({ targetDir, payloadTransaction }) => {
      await withPluginLifecycleLease({}, async (lease) => {
        const transaction = await stageHookInstall({
          update: { hookId: "alpha", source: "path", installPath: targetDir, version: undefined },
          payloadTransaction,
          lease,
        });
        const hookId = writer === "replacement" ? "alpha" : "beta";
        recordHookInstall({ hookId, source: "npm", version: "2.0.0" });

        if (writer === "replacement") {
          await expect(transaction.rollback()).rejects.toThrow("newer record and payload retained");
          expect(fs.existsSync(targetDir)).toBe(true);
        } else {
          await transaction.rollback();
          expect(fs.existsSync(targetDir)).toBe(false);
          expect(readHookInstalls().alpha).toBeUndefined();
        }
        expect(readHookInstalls()[hookId]).toMatchObject({ source: "npm", version: "2.0.0" });
      });
    });
  },
);

it.each(["logging", "cleanup"] as const)(
  "keeps committed state after a %s failure",
  async (failure) =>
    withHookInstallFixture(
      "update",
      async ({ configPath, targetDir, payloadTransaction, persist }) => {
        if (!payloadTransaction) {
          throw new Error("expected payload transaction");
        }
        if (failure === "cleanup") {
          const commit = payloadTransaction.commit.bind(payloadTransaction);
          vi.spyOn(payloadTransaction, "commit").mockImplementation(async () => {
            await commit();
            throw new Error("cleanup unavailable");
          });
        }
        await expect(
          persist({
            log(message) {
              if (String(message).startsWith("Installed hook pack:")) {
                throw new Error("logging unavailable");
              }
            },
          }),
        ).rejects.toThrow(failure === "cleanup" ? "committed" : "logging unavailable");

        expect(readHookInstalls().alpha).toMatchObject({ version: "2.0.0" });
        expect(readPayload(targetDir)).toBe("candidate");
        expect(readEntry(configPath)).toBe(true);
      },
    ),
);
