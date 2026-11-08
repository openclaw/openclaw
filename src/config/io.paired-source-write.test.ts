import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import * as tmpDirOwner from "../infra/tmp-openclaw-dir.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { setConfigValueAtPath } from "./config-paths.js";
import { createConfigIO } from "./io.js";
import { replaceConfigFile } from "./mutate.js";
import { withTempHome, writeOpenClawConfig } from "./test-helpers.js";
import type { OpenClawConfig } from "./types.openclaw.js";

afterEach(() => closeOpenClawStateDatabaseForTest());

function createIO(home: string, configPath: string, vars: NodeJS.ProcessEnv, skipPlugins = false) {
  return createConfigIO({
    configPath,
    homedir: () => home,
    ...(skipPlugins ? { pluginValidation: "skip" as const } : {}),
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.dirname(configPath),
      ...vars,
    },
  });
}

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
      const includes = {
        "account.json": '{"appId":"${CONFIG_PAIRED_WEBHOOK_APP}"}\n',
        "slack.json": '{"mode":"socket"}\n',
        "empty-account.json": "{}\n",
      };
      const includePath = (name: string) => path.join(path.dirname(configPath), name);
      for (const [name, raw] of Object.entries(includes)) {
        await fs.writeFile(includePath(name), raw);
      }
      const rootBefore = await fs.readFile(configPath, "utf8");
      const io = createIO(home, configPath, { CONFIG_PAIRED_WEBHOOK_APP: "test-app" }, true);
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
      expect(saved.channels?.feishu?.accounts).toEqual({
        work: { $include: "./account.json", legacyWebhook: endpoint },
        personal: { $include: "./account.json" },
        empty: { $include: "./empty-account.json", legacyWebhook: endpoint },
      });
      expect(saved.channels?.slack).toEqual({ $include: "./slack.json" });
      expect(saved.meta?.migrations?.webhookListeners).toEqual({
        feishu: [pinPath, emptyPinPath],
      });
      expect(saved.logging?.level).toBe("debug");
      for (const [name, raw] of Object.entries(includes)) {
        expect(await fs.readFile(includePath(name), "utf8")).toBe(raw);
      }
      expect(await fs.readFile(configPath + ".bak", "utf8")).toBe(rootBefore);
    });
  },
);

it.each(["root", "include", "literal", "roster"])(
  "preserves authored references through environment drift (%s)",
  async (mode) => {
    await withTempHome(async (home) => {
      const include = mode === "include";
      const direct = mode === "literal" || mode === "roster";
      const browser = { enabled: true, executablePath: "${PAIRED_BIN}" };
      const file = await writeOpenClawConfig(home, {
        gateway: { mode: "local" },
        ...(direct ? { session: { store: path.join(home, "sessions.json") } } : {}),
        agents: {
          ...(direct ? { defaults: { workspace: "${PAIRED_WORK}" } } : {}),
          entries: { main: { name: "/opt/browser-before" } },
        },
        browser: include ? { $include: "./browser.json" } : browser,
      });
      const includeFile = path.join(path.dirname(file), "browser.json");
      if (include) {
        await fs.writeFile(includeFile, JSON.stringify(browser) + "\n");
      }
      const rootBefore = await fs.readFile(file, "utf8");
      const owned = include ? includeFile : file;
      const ownedBefore = await fs.readFile(owned, "utf8");
      const io = createIO(home, file, {
        PAIRED_BIN: "/opt/browser-before",
        ...(direct ? { PAIRED_WORK: "/opt/workspace-before" } : {}),
      });
      const { snapshot, writeOptions } = await io.readConfigFileSnapshotForWrite({
        observe: false,
      });
      expect(snapshot.valid).toBe(true);
      expect(snapshot.sourceConfig.browser?.executablePath).toBe("/opt/browser-before");
      if (!direct) {
        expect(snapshot.authoredConfig?.browser?.executablePath).toBe("${PAIRED_BIN}");
      }
      io.env.PAIRED_BIN = "/opt/browser-after";
      if (direct) {
        io.env.PAIRED_WORK = "/opt/workspace-after";
      }
      const next = {
        ...snapshot.sourceConfig,
        browser: { ...snapshot.sourceConfig.browser, enabled: false },
      };
      if (mode === "literal") {
        next.browser.executablePath = "/opt/browser-after";
      }
      if (direct) {
        next.agents = {
          ...next.agents,
          entries: { ...next.agents?.entries, ...(mode === "roster" ? { secondary: {} } : {}) },
        };
      }
      const submitted = structuredClone(next);
      if (direct) {
        await io.writeConfigFile(next, { ...writeOptions, observe: false });
        expect(next).toEqual(submitted);
      } else {
        await replaceConfigFile({
          snapshot,
          baseHash: snapshot.hash,
          sourceConfig: next,
          writeOptions: { ...writeOptions, observe: false },
          io,
        });
      }
      const saved = JSON.parse(await fs.readFile(owned, "utf8"));
      const expectedBrowser = {
        enabled: false,
        executablePath: mode === "literal" ? "/opt/browser-after" : "${PAIRED_BIN}",
      };
      if (direct) {
        expect(saved.browser).toEqual(expectedBrowser);
        expect(saved.agents.defaults.workspace).toBe("${PAIRED_WORK}");
        expect(saved.agents.entries.main.name).toBe("/opt/browser-before");
        if (mode === "roster") {
          expect(saved.agents).toMatchObject({
            ownership: "explicit",
            entries: { main: { workspace: "/opt/workspace-after" } },
            defaults: { sessionStore: { agentId: "main" } },
          });
          expect(saved.agents.entries.secondary).toEqual({});
        } else {
          expect(saved.agents.ownership).toBeUndefined();
          expect(saved.agents.entries.main.workspace).toBeUndefined();
        }
        io.env.PAIRED_BIN = "/opt/browser-later";
      } else {
        expect(include ? saved : saved.browser).toMatchObject(expectedBrowser);
        expect(await fs.readFile(owned + ".bak", "utf8")).toBe(ownedBefore);
        if (include) {
          expect(await fs.readFile(file, "utf8")).toBe(rootBefore);
        }
      }
      const reloaded = await io.readConfigFileSnapshot({ observe: false });
      if (direct) {
        expect(reloaded.valid).toBe(true);
      } else {
        expect(reloaded.sourceConfig.agents?.entries?.main?.name).toBe("/opt/browser-before");
      }
      expect(reloaded.sourceConfig.browser?.executablePath).toBe(
        mode === "roster" ? "/opt/browser-later" : "/opt/browser-after",
      );
    });
  },
);
