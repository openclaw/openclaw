import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { getConfigValueAtPath, setConfigValueAtPath } from "./config-paths.js";
import { createConfigIO } from "./io.js";
import { replaceConfigFile } from "./mutate.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

describe("paired source through the public config writer", () => {
  const roots = createSuiteTempRootTracker({ prefix: "config-paired-coordinator-" });
  beforeAll(async () => {
    await roots.setup();
    vi.spyOn(tmpDirOwner, "resolvePreferredOpenClawTmpDir").mockReturnValue(
      await roots.make("coordinator"),
    );
  });
  afterAll(async () => {
    vi.mocked(tmpDirOwner.resolvePreferredOpenClawTmpDir).mockRestore();
    await roots.cleanup();
  });

  it.each(["direct", "mutation"] as const)(
    "keeps webhook migration overrides scoped beside account includes (%s writer)",
    async (writer) => {
      await withTempHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          channels: {
            feishu: {
              accounts: {
                work: { $include: "./account.json" },
                personal: { $include: "./account.json" },
                empty: { $include: "./empty-account.json" },
              },
            },
            slack: { $include: "./slack.json" },
          },
        });
        const accountPath = path.join(path.dirname(configPath), "account.json");
        const slackPath = path.join(path.dirname(configPath), "slack.json");
        const emptyAccountPath = path.join(path.dirname(configPath), "empty-account.json");
        const accountRaw = '{"appId":"${CONFIG_PAIRED_WEBHOOK_APP}"}\n';
        const slackRaw = '{"mode":"socket"}\n';
        await fs.writeFile(accountPath, accountRaw);
        await fs.writeFile(slackPath, slackRaw);
        await fs.writeFile(emptyAccountPath, "{}\n");
        const rootBefore = await fs.readFile(configPath, "utf8");
        const io = createConfigIO({
          configPath,
          homedir: () => home,
          pluginValidation: "skip",
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: path.dirname(configPath),
            CONFIG_PAIRED_WEBHOOK_APP: "test-app",
          },
        });
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({
          observe: false,
        });
        expect(snapshot.valid).toBe(true);
        const pinPath = ["channels", "feishu", "accounts", "work", "legacyWebhook"];
        const emptyPinPath = ["channels", "feishu", "accounts", "empty", "legacyWebhook"];
        const endpoint = { host: "127.0.0.1", port: 3000 };
        const next = structuredClone(snapshot.sourceConfig);
        setConfigValueAtPath(next, pinPath, endpoint);
        setConfigValueAtPath(next, emptyPinPath, endpoint);
        setConfigValueAtPath(next, ["meta", "migrations", "webhookListeners"], {
          feishu: [pinPath, emptyPinPath],
        });
        const options = {
          ...writeOptions,
          inputBase: "source" as const,
          observe: false,
          skipPluginValidation: true,
          explicitSetPaths: [["logging", "level"]],
          explicitSetValueSource: { logging: { level: "debug" as const } },
        };
        const write = (candidate: OpenClawConfig) =>
          writer === "direct"
            ? io.writeConfigFile(candidate, { ...options, baseSnapshot: snapshot })
            : replaceConfigFile({ snapshot, sourceConfig: candidate, writeOptions: options, io });

        for (const [field, value] of [
          [["channels", "slack", "enabled"], true],
          [["channels", "feishu", "accounts", "personal", "legacyWebhook"], endpoint],
        ] satisfies [string[], unknown][]) {
          const unrelatedRepair = structuredClone(next);
          setConfigValueAtPath(unrelatedRepair, field, value);
          await expect(write(unrelatedRepair)).rejects.toThrow("flatten $include-owned config");
          expect(await fs.readFile(configPath, "utf8")).toBe(rootBefore);
        }

        await write(next);
        const saved: OpenClawConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(getConfigValueAtPath(saved, pinPath)).toEqual(endpoint);
        expect(getConfigValueAtPath(saved, ["channels", "feishu", "accounts", "work"])).toEqual({
          $include: "./account.json",
          legacyWebhook: endpoint,
        });
        expect(getConfigValueAtPath(saved, ["channels", "feishu", "accounts", "personal"])).toEqual(
          {
            $include: "./account.json",
          },
        );
        expect(saved.channels?.slack).toEqual({ $include: "./slack.json" });
        expect(getConfigValueAtPath(saved, ["channels", "feishu", "accounts", "empty"])).toEqual({
          $include: "./empty-account.json",
          legacyWebhook: endpoint,
        });
        expect(saved.meta?.migrations?.webhookListeners).toEqual({
          feishu: [pinPath, emptyPinPath],
        });
        expect(saved.logging?.level).toBe("debug");
        expect(await fs.readFile(accountPath, "utf8")).toBe(accountRaw);
        expect(await fs.readFile(slackPath, "utf8")).toBe(slackRaw);
        expect(await fs.readFile(emptyAccountPath, "utf8")).toBe("{}\n");
        expect(await fs.readFile(configPath + ".bak", "utf8")).toBe(rootBefore);
      });
    },
  );

  it.each([false, true])(
    "retains authored identity after read-time environment drift (include=%s)",
    async (include) => {
      await withTempHome(async (home) => {
        const browser = { enabled: true, executablePath: "${CONFIG_PAIRED_BROWSER}" };
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          agents: { entries: { main: { name: "/opt/browser-before" } } },
          browser: include ? { $include: "./browser.json" } : browser,
        });
        const includePath = path.join(path.dirname(configPath), "browser.json");
        if (include) {
          await fs.writeFile(includePath, JSON.stringify(browser) + "\n");
        }
        const rootBefore = await fs.readFile(configPath, "utf8");
        const ownedPath = include ? includePath : configPath;
        const ownedBefore = await fs.readFile(ownedPath, "utf8");
        const env = {
          ...process.env,
          OPENCLAW_CONFIG_PATH: configPath,
          OPENCLAW_STATE_DIR: path.dirname(configPath),
          CONFIG_PAIRED_BROWSER: "/opt/browser-before",
        };
        const io = createConfigIO({ env, configPath, homedir: () => home });
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({
          observe: false,
        });
        expect(snapshot.valid).toBe(true);
        expect(snapshot.authoredConfig?.browser?.executablePath).toBe("${CONFIG_PAIRED_BROWSER}");
        expect(snapshot.sourceConfig.browser?.executablePath).toBe("/opt/browser-before");
        io.env.CONFIG_PAIRED_BROWSER = "/opt/browser-after";
        await replaceConfigFile({
          snapshot,
          baseHash: snapshot.hash,
          sourceConfig: {
            ...snapshot.sourceConfig,
            browser: { ...snapshot.sourceConfig.browser, enabled: false },
          },
          writeOptions: { ...writeOptions, observe: false },
          io,
        });
        const saved = JSON.parse(await fs.readFile(ownedPath, "utf8"));
        expect(include ? saved : saved.browser).toMatchObject({
          enabled: false,
          executablePath: "${CONFIG_PAIRED_BROWSER}",
        });
        expect(await fs.readFile(ownedPath + ".bak", "utf8")).toBe(ownedBefore);
        const reloaded = await io.readConfigFileSnapshot({ observe: false });
        expect(reloaded.sourceConfig.browser?.executablePath).toBe("/opt/browser-after");
        expect(reloaded.sourceConfig.agents?.entries?.main?.name).toBe("/opt/browser-before");
        if (include) {
          expect(await fs.readFile(configPath, "utf8")).toBe(rootBefore);
        }
      });
    },
  );

  it.each([
    { literalEdit: true, expandRoster: false },
    { literalEdit: false, expandRoster: true },
  ])(
    "distinguishes acquired references from literal edits (literal=$literalEdit, topology=$expandRoster)",
    async ({ literalEdit, expandRoster }) => {
      await withTempHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          session: { store: path.join(home, "sessions.json") },
          agents: {
            defaults: { workspace: "${CONFIG_PAIRED_WORKSPACE}" },
            entries: { main: { name: "/opt/browser-before" } },
          },
          browser: { enabled: true, executablePath: "${CONFIG_PAIRED_BROWSER}" },
        });
        const io = createConfigIO({
          configPath,
          homedir: () => home,
          env: {
            ...process.env,
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: path.dirname(configPath),
            CONFIG_PAIRED_BROWSER: "/opt/browser-before",
            CONFIG_PAIRED_WORKSPACE: "/opt/workspace-before",
          },
        });
        const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({
          observe: false,
        });
        expect(snapshot.valid).toBe(true);
        expect(snapshot.sourceConfig.browser?.executablePath).toBe("/opt/browser-before");
        io.env.CONFIG_PAIRED_BROWSER = "/opt/browser-after";
        io.env.CONFIG_PAIRED_WORKSPACE = "/opt/workspace-after";
        const next = {
          ...snapshot.sourceConfig,
          browser: {
            ...snapshot.sourceConfig.browser,
            enabled: false,
            executablePath: literalEdit
              ? "/opt/browser-after"
              : snapshot.sourceConfig.browser?.executablePath,
          },
          agents: {
            ...snapshot.sourceConfig.agents,
            entries: {
              ...snapshot.sourceConfig.agents?.entries,
              ...(expandRoster ? { secondary: {} } : {}),
            },
          },
        };
        const submitted = structuredClone(next);
        await io.writeConfigFile(next, { ...writeOptions, observe: false });
        expect(next).toEqual(submitted);
        const saved = JSON.parse(await fs.readFile(configPath, "utf8"));
        expect(saved.browser).toEqual({
          enabled: false,
          executablePath: literalEdit ? "/opt/browser-after" : "${CONFIG_PAIRED_BROWSER}",
        });
        expect(saved.agents.defaults.workspace).toBe("${CONFIG_PAIRED_WORKSPACE}");
        expect(saved.agents.entries.main.name).toBe("/opt/browser-before");
        if (expandRoster) {
          expect(saved.agents.ownership).toBe("explicit");
          expect(saved.agents.entries.main.workspace).toBe("/opt/workspace-after");
          expect(saved.agents.defaults.sessionStore.agentId).toBe("main");
          expect(saved.agents.entries.secondary).toEqual({});
        } else {
          expect(saved.agents.ownership).toBeUndefined();
          expect(saved.agents.entries.main.workspace).toBeUndefined();
        }
        io.env.CONFIG_PAIRED_BROWSER = "/opt/browser-later";
        const reloaded = await io.readConfigFileSnapshot({ observe: false });
        expect(reloaded.valid).toBe(true);
        expect(reloaded.sourceConfig.browser?.executablePath).toBe(
          literalEdit ? "/opt/browser-after" : "/opt/browser-later",
        );
      });
    },
  );
});
