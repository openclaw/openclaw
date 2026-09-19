import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistRequestedUpdateChannel } from "./update-command-config.js";
import { withUpdateCommandExecutor } from "./update-command-executor.js";

afterEach(() => vi.restoreAllMocks());

it.each([true, false])(
  "rolls back an include channel when config selection changes during refresh (handled=%s)",
  async (handled) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      await state.writeConfig({
        plugins: { enabled: false },
        update: { $include: "./channel.json" },
      });
      const include = state.statePath("channel.json");
      const original = '{"channel":"stable"}\n';
      await fs.writeFile(include, original);
      const originalRoot = await fs.readFile(state.configPath, "utf8");
      const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
      expect(snapshot.valid).toBe(true);
      setRuntimeConfigSnapshot(snapshot.runtimeConfig, snapshot.sourceConfig);
      const previousRuntime = getRuntimeConfigSnapshot();
      const notified = vi.fn();
      const unsubscribe = registerRuntimeConfigWriteListener(notified);
      const refresh = vi.fn(async () => {
        await Promise.resolve();
        process.env.OPENCLAW_CONFIG_PATH = state.statePath("reselected.json");
        return handled;
      });
      setRuntimeConfigSnapshotRefreshHandler({ preflight: () => true, refresh });
      try {
        await expect(
          persistRequestedUpdateChannel({ configSnapshot: snapshot, requestedChannel: "beta" }),
        ).rejects.toMatchObject({ name: "ConfigWritePostCommitError", rollbackStatus: "restored" });
        expect(refresh).toHaveBeenCalledOnce();
        expect(notified).not.toHaveBeenCalled();
        expect(getRuntimeConfigSnapshot()).toBe(previousRuntime);
        expect(await fs.readFile(include, "utf8")).toBe(original);
        expect(await fs.readFile(`${include}.bak`, "utf8")).toBe(original);
        expect(await fs.readFile(state.configPath, "utf8")).toBe(originalRoot);
      } finally {
        process.env.OPENCLAW_CONFIG_PATH = state.configPath;
        unsubscribe();
        setRuntimeConfigSnapshotRefreshHandler(null);
        resetConfigRuntimeState();
      }
    });
  },
);

it("changes an include-owned requested update channel under a live executor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const control = state.path("control");
    const root = state.path("install");
    await fs.mkdir(control, { mode: 0o700 });
    await fs.mkdir(root);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    await state.writeConfig({
      plugins: { enabled: false },
      update: { $include: "./channel.json" },
      logging: { $include: "./logging.json" },
    });
    const include = state.statePath("channel.json");
    await fs.writeFile(include, '{"channel":"stable"}\n');
    const unrelated = state.statePath("logging.json");
    await fs.writeFile(unrelated, '{"level":"info"}\n');
    const originalRoot = await fs.readFile(state.configPath, "utf8");
    const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
    expect(snapshot.valid).toBe(true);
    expect(snapshot.config.update?.channel).toBe("stable");
    const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(root);
      fence.assertCurrent();
      const result = await persistRequestedUpdateChannel({
        configSnapshot: snapshot,
        requestedChannel: "beta",
        assertCurrent: fence.assertCurrent,
      }).catch(async (error: unknown) => {
        // Distinguish capability refusal from a revoked fixture or lost input.
        fence.assertCurrent();
        expect(JSON.parse(await fs.readFile(include, "utf8")).channel).toBe("stable");
        expect(await fs.readFile(state.configPath, "utf8")).toBe(originalRoot);
        throw error;
      });
      expect(result.config.update?.channel).toBe("beta");
      fence.assertCurrent();
    });
    expect(JSON.parse(await fs.readFile(include, "utf8")).channel).toBe("beta");
    expect(await fs.readFile(state.configPath, "utf8")).toBe(originalRoot);
    expect(await fs.readFile(unrelated, "utf8")).toBe('{"level":"info"}\n');
    expect(await fs.readFile(`${include}.bak`, "utf8")).toBe('{"channel":"stable"}\n');
  });
});

it.each(["expired", "revoked", "parent-replaced"] as const)(
  "requested include channel refuses %s authority after awaited preparation",
  async (fault) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const control = state.path("control");
      const root = state.path("install");
      await fs.mkdir(control);
      await fs.mkdir(root);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await state.writeConfig({
        plugins: { enabled: false },
        update: { $include: "./fragments/channel.json" },
      });
      const dir = state.statePath("fragments");
      await fs.mkdir(dir);
      const include = path.join(dir, "channel.json");
      const raw = '{"channel":"stable"}\n';
      await fs.writeFile(include, raw);
      const originalRoot = await fs.readFile(state.configPath, "utf8");
      const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      let reached = false;
      const now = Date.now();
      const operation = withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(root, { activationTimeoutMs: 60_000 });
        const open = fs.open;
        vi.spyOn(fs, "open").mockImplementation(async (...args) => {
          const handle = await open(...args);
          if (!reached && String(args[0]).includes("openclaw-config-backup")) {
            reached = true;
            if (fault === "expired") {
              vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
            }
            if (fault === "revoked") {
              const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
              try {
                db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
                  "replacement",
                  root,
                );
              } finally {
                db.close();
              }
            }
            if (fault === "parent-replaced") {
              syncFs.renameSync(dir, `${dir}-old`);
              syncFs.mkdirSync(dir);
              syncFs.writeFileSync(include, raw);
            }
          }
          return handle;
        });
        return await persistRequestedUpdateChannel({
          configSnapshot: snapshot,
          requestedChannel: "beta",
          assertCurrent: fence.assertCurrent,
        });
      });
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
      expect(reached).toBe(true);
      expect(await fs.readFile(include, "utf8")).toBe(raw);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(originalRoot);
      expect(syncFs.existsSync(`${include}.bak`)).toBe(false);
      if (fault === "parent-replaced") {
        expect(await fs.readFile(path.join(`${dir}-old`, "channel.json"), "utf8")).toBe(raw);
      }
    });
  },
);

it("migrates a nested internal sandbox fragment under the original executor", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const control = state.path("control");
    const root = state.path("install");
    await fs.mkdir(control);
    await fs.mkdir(root);
    vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
    await state.writeConfig({
      plugins: { enabled: false },
      agents: { entries: { main: { $include: "./agent-parent.json" } } },
    });
    const parent = state.statePath("agent-parent.json");
    const fragment = state.statePath("agent.json");
    const parentRaw = '{"$include":"./agent.json"}\n';
    const fragmentRaw = '{"sandbox":{"perSession":true}}\n';
    await fs.writeFile(parent, parentRaw);
    await fs.writeFile(fragment, fragmentRaw);
    const rootRaw = await fs.readFile(state.configPath, "utf8");
    const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
    await withUpdateCommandExecutor(run.runId, async (executor) => {
      const fence = await executor.enter(root);
      const io = createConfigIO({ observe: false, pluginValidation: "skip" });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite();
      const next = structuredClone(snapshot.sourceConfig);
      const sandbox = next.agents?.entries?.main?.sandbox;
      if (!sandbox) {
        throw new Error("missing authored legacy sandbox");
      }
      sandbox.scope = "session";
      Reflect.deleteProperty(sandbox, "perSession");
      await replaceConfigFile({
        snapshot,
        nextConfig: next,
        writeOptions: {
          ...writeOptions,
          assertCurrent: fence.assertCurrent,
          skipPluginValidation: true,
          inputBase: "source",
          unsetPaths: [["agents", "entries", "main", "sandbox", "perSession"]],
        },
      });
      fence.assertCurrent();
    });
    expect(JSON.parse(await fs.readFile(fragment, "utf8"))).toEqual({
      sandbox: { scope: "session" },
    });
    expect(await fs.readFile(`${fragment}.bak`, "utf8")).toBe(fragmentRaw);
    expect(await fs.readFile(parent, "utf8")).toBe(parentRaw);
    expect(await fs.readFile(state.configPath, "utf8")).toBe(rootRaw);
  });
});

it.each(["revoked", "replacement"] as const)(
  "records committed include state without unauthorized rollback after %s",
  async (fault) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const control = state.path("control");
      const root = state.path("install");
      await fs.mkdir(control);
      await fs.mkdir(root);
      vi.spyOn(tempRoot, "resolvePreferredOpenClawTmpDir").mockReturnValue(control);
      await state.writeConfig({
        plugins: { enabled: false },
        update: { $include: "./channel.json" },
      });
      const fragment = state.statePath("channel.json");
      const raw = '{"channel":"stable"}\n';
      await fs.writeFile(fragment, raw);
      const rootRaw = await fs.readFile(state.configPath, "utf8");
      const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true, observe: false });
      const run = createUpdateRun({ trigger: "cli" }, { env: state.env });
      let reached = false;
      let committed = "";
      const operation = withUpdateCommandExecutor(run.runId, async (executor) => {
        const fence = await executor.enter(root);
        const rename = syncFs.renameSync;
        vi.spyOn(syncFs, "renameSync").mockImplementation((from, to) => {
          rename(from, to);
          if (!reached && to === fragment) {
            reached = true;
            committed = syncFs.readFileSync(fragment, "utf8");
            if (fault === "revoked") {
              const db = new DatabaseSync(path.join(control, "managed-update-handoffs.sqlite"));
              try {
                db.prepare("UPDATE managed_update_handoffs SET owner=? WHERE install_root=?").run(
                  "replacement",
                  root,
                );
              } finally {
                db.close();
              }
            } else {
              rename(fragment, `${fragment}.owned`);
              syncFs.writeFileSync(fragment, committed);
            }
          }
        });
        return await persistRequestedUpdateChannel({
          configSnapshot: snapshot,
          requestedChannel: "beta",
          assertCurrent: fence.assertCurrent,
        });
      });
      const failure = await operation.then(
        () => undefined,
        (error: unknown) => error,
      );
      const failures: unknown[] = [];
      const collect = (error: unknown) => {
        failures.push(error);
        if (error instanceof Error && error.cause) {
          collect(error.cause);
        }
        if (error instanceof AggregateError) {
          for (const child of error.errors) {
            collect(child);
          }
        }
      };
      collect(failure);
      expect(failures).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "ConfigWritePostCommitError",
            publication: "complete",
            rollbackStatus: "unknown",
          }),
        ]),
      );
      expect(reached).toBe(true);
      expect(JSON.parse(committed).channel).toBe("beta");
      expect(await fs.readFile(fragment, "utf8")).toBe(committed);
      expect(await fs.readFile(`${fragment}.bak`, "utf8")).toBe(raw);
      expect(await fs.readFile(state.configPath, "utf8")).toBe(rootRaw);
    });
  },
);
