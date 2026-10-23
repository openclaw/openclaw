import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import { afterEach, expect, it, vi } from "vitest";
import { readConfigFileSnapshot, createConfigIO, replaceConfigFile } from "../../config/config.js";
import {
  getRuntimeConfigSnapshot,
  registerRuntimeConfigWriteListener,
  resetConfigRuntimeState,
  setRuntimeConfigSnapshot,
  setRuntimeConfigSnapshotRefreshHandler,
} from "../../config/runtime-snapshot.js";
import * as tempRoot from "../../infra/tmp-openclaw-dir.js";
import { createUpdateRun } from "../../infra/update-run-ledger.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { persistRequestedUpdateChannel } from "./update-command-config.js";
import {
  withUpdateCommandExecutor,
  type UpdateCommandExecutor,
} from "./update-command-executor.js";

afterEach(() => vi.restoreAllMocks());

const raw = '{"channel":"stable"}\n';
const readFiles = (...files: string[]) =>
  Promise.all(files.map((file) => fs.readFile(file, "utf8")));

async function createExecutorPaths(state: OpenClawTestState) {
  const control = state.path("control");
  const root = state.path("install");
  await fs.mkdir(control, { mode: 0o700 });
  await fs.mkdir(root);
  vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
  return {
    revoke: () => revokeExecutor(control, root),
    run: <T>(
      work: (fence: Awaited<ReturnType<UpdateCommandExecutor["enter"]>>) => Promise<T>,
      options?: Parameters<UpdateCommandExecutor["enter"]>[1],
    ) =>
      withUpdateCommandExecutor(
        createUpdateRun({ trigger: "cli" }, { env: state.env }).runId,
        async (executor) => work(await executor.enter(root, options)),
      ),
  };
}

async function writeChannelFixture(
  state: OpenClawTestState,
  relativePath = "./channel.json",
  extraConfig: Record<string, unknown> = {},
) {
  await state.writeConfig({
    plugins: { enabled: false },
    update: { $include: relativePath },
    ...extraConfig,
  });
  const include = state.statePath(relativePath);
  await fs.mkdir(path.dirname(include), { recursive: true });
  await fs.writeFile(include, raw);
  const originalRoot = await fs.readFile(state.configPath, "utf8");
  const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
  return {
    include,
    originalRoot,
    snapshot,
    persist: (assertCurrent?: () => void) =>
      persistRequestedUpdateChannel({
        configSnapshot: snapshot,
        requestedChannel: "beta",
        assertCurrent,
      }),
  };
}

function revokeExecutor(control: string, root: string) {
  using db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
  db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
    "replacement",
    root,
  );
}

it("rolls back an include channel when config selection changes during refresh", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const { include, originalRoot, snapshot, persist } = await writeChannelFixture(state);
    expect(snapshot.valid).toBe(true);
    setRuntimeConfigSnapshot(snapshot.runtimeConfig, snapshot.sourceConfig);
    const previousRuntime = getRuntimeConfigSnapshot();
    const notified = vi.fn();
    const unsubscribe = registerRuntimeConfigWriteListener(notified);
    const refresh = vi.fn(async () => {
      await Promise.resolve();
      process.env.OPENCLAW_CONFIG_PATH = state.statePath("reselected.json");
      return false;
    });
    setRuntimeConfigSnapshotRefreshHandler({ preflight: () => true, refresh });
    try {
      await expect(persist()).rejects.toMatchObject({
        name: "ConfigWritePostCommitError",
        rollbackStatus: "restored",
      });
      expect(refresh).toHaveBeenCalledOnce();
      expect(notified).not.toHaveBeenCalled();
      expect(getRuntimeConfigSnapshot()).toBe(previousRuntime);
      expect(await readFiles(include, `${include}.bak`, state.configPath)).toEqual([
        raw,
        raw,
        originalRoot,
      ]);
    } finally {
      process.env.OPENCLAW_CONFIG_PATH = state.configPath;
      unsubscribe();
      setRuntimeConfigSnapshotRefreshHandler(null);
      resetConfigRuntimeState();
    }
  });
});

it("changes an include-owned requested update channel under a live executor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const executor = await createExecutorPaths(state);
    const unrelated = state.statePath("logging.json");
    await fs.writeFile(unrelated, '{"level":"info"}\n');
    const { include, originalRoot, snapshot, persist } = await writeChannelFixture(
      state,
      "./channel.json",
      {
        logging: { $include: "./logging.json" },
      },
    );
    expect(snapshot).toMatchObject({ valid: true, config: { update: { channel: "stable" } } });
    await executor.run(async (fence) => {
      fence.assertCurrent();
      const result = await persist(fence.assertCurrent);
      expect(result.config.update?.channel).toBe("beta");
      fence.assertCurrent();
    });
    expect(JSON.parse(await fs.readFile(include, "utf8")).channel).toBe("beta");
    expect(await readFiles(state.configPath, unrelated, `${include}.bak`)).toEqual([
      originalRoot,
      '{"level":"info"}\n',
      raw,
    ]);
  });
});

it.each([
  { phase: "prepare", fault: "expired" },
  { phase: "prepare", fault: "revoked" },
  { phase: "prepare", fault: "parent-replaced" },
  { phase: "committed", fault: "revoked" },
  { phase: "committed", fault: "replacement" },
])("preserves include state when $phase authority is $fault", async ({ phase, fault }) => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const executor = await createExecutorPaths(state);
    const preparing = phase === "prepare";
    const { include, originalRoot, persist } = await writeChannelFixture(
      state,
      preparing ? "./fragments/channel.json" : "./channel.json",
    );
    const dir = path.dirname(include);
    const now = Date.now();
    vi.spyOn(performance, "now").mockImplementation(() => Date.now());
    let reached = false;
    let committed = "";
    const operation = executor.run(
      async (fence) => {
        if (preparing) {
          const open = fs.open;
          vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await open(...args);
            if (!reached && String(args[0]).includes("openclaw-config-backup")) {
              reached = true;
              if (fault === "expired") {
                vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
              }
              if (fault === "revoked") {
                executor.revoke();
              }
              if (fault === "parent-replaced") {
                syncFs.renameSync(dir, `${dir}-old`);
                syncFs.mkdirSync(dir);
                syncFs.writeFileSync(include, raw);
              }
            }
            return handle;
          });
        } else {
          const rename = syncFs.renameSync;
          vi.spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
            rename(from, to);
            if (!reached && to === include) {
              reached = true;
              committed = syncFs.readFileSync(include, "utf8");
              if (fault === "revoked") {
                executor.revoke();
              } else {
                rename(include, `${include}.owned`);
                syncFs.writeFileSync(include, committed);
              }
            }
          });
        }
        return persist(fence.assertCurrent);
      },
      preparing ? { activationTimeoutMs: 60_000 } : undefined,
    );
    if (!preparing) {
      const failure = await operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(collectNestedErrorCandidates(failure)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "ConfigWritePostCommitError",
            publication: "complete",
            rollbackStatus: "unknown",
          }),
        ]),
      );
      expect(JSON.parse(committed).channel).toBe("beta");
      expect(await readFiles(include, `${include}.bak`)).toEqual([committed, raw]);
    } else {
      if (fault === "revoked") {
        await expect(operation).rejects.toMatchObject({
          cause: expect.objectContaining({
            errors: expect.arrayContaining([
              expect.objectContaining({ message: expect.stringMatching(/executor ownership/) }),
            ]),
          }),
        });
      } else {
        await expect(operation).rejects.toThrow(/activation|target changed/);
      }
      vi.restoreAllMocks();
      expect(await fs.readFile(include, "utf8")).toBe(raw);
      expect(syncFs.existsSync(`${include}.bak`)).toBe(false);
      if (fault === "parent-replaced") {
        expect(await fs.readFile(path.join(`${dir}-old`, "channel.json"), "utf8")).toBe(raw);
      }
    }
    expect(reached).toBe(true);
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalRoot);
  });
});

it("migrates a nested internal sandbox fragment under the original executor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const executor = await createExecutorPaths(state);
    await state.writeConfig({
      plugins: { enabled: false },
      agents: { entries: { main: { $include: "./agent-parent.json" } } },
    });
    const parent = state.statePath("agent-parent.json");
    const fragment = state.statePath("agent.json");
    const parentRaw = '{"$include":"./agent.json"}\n';
    const fragmentRaw = '{"sandbox":{"browser":{"enableNoVnc":true}}}\n';
    await fs.writeFile(parent, parentRaw);
    await fs.writeFile(fragment, fragmentRaw);
    const rootRaw = await fs.readFile(state.configPath, "utf8");
    await executor.run(async (fence) => {
      const io = createConfigIO({ observe: false, pluginValidation: "skip" });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      const next = structuredClone(snapshot.sourceConfig);
      const browser = next.agents?.entries?.main?.sandbox?.browser;
      if (!browser) {
        throw new Error("missing authored legacy sandbox browser");
      }
      browser.noVncEnabled = true;
      Reflect.deleteProperty(browser, "enableNoVnc");
      await replaceConfigFile({
        snapshot,
        nextConfig: next,
        writeOptions: {
          ...writeOptions,
          assertCurrent: fence.assertCurrent,
          skipPluginValidation: true,
          inputBase: "source",
          unsetPaths: [["agents", "entries", "main", "sandbox", "browser", "enableNoVnc"]],
        },
      });
      fence.assertCurrent();
    });
    expect(JSON.parse(await fs.readFile(fragment, "utf8"))).toEqual({
      sandbox: { browser: { noVncEnabled: true } },
    });
    expect(await readFiles(`${fragment}.bak`, parent, state.configPath)).toEqual([
      fragmentRaw,
      parentRaw,
      rootRaw,
    ]);
  });
});
