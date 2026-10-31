import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createConfigIO } from "./io.factory.js";
import type { AgentDefaultsConfig } from "./types.agent-defaults.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  clearPluginMetadataLifecycleCaches();
  closeOpenClawStateDatabaseForTest();
});

function fixture(enabled: unknown) {
  const root = tempDirs.make("openclaw-pdf-opt-in-config-");
  const configPath = path.join(root, "openclaw.json");
  const defaults = {
    pdfModel: {
      primary: "openai/gpt-4.1-mini",
      fallbacks: ["google/gemini-2.5-pro", "anthropic/claude-sonnet-4-6"],
    },
    pdfMaxPages: 7,
    pdfMaxMb: 8,
    ...(enabled === undefined ? {} : { pdfNativeOpenai: enabled }),
  };
  fs.writeFileSync(configPath, JSON.stringify({ agents: { defaults } }));
  const io = createConfigIO({
    configPath,
    pluginValidation: "core-only",
    env: {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    },
    homedir: () => root,
    observe: false,
  });
  return { io, defaults, configPath };
}

describe("saved PDF native OpenAI opt-in", () => {
  it.each([undefined, false, true])(
    "retains the authored setting and existing provider order on read/write (%s)",
    async (enabled) => {
      // Also exercises the public schema-derived config type.
      const typed: Pick<AgentDefaultsConfig, "pdfNativeOpenai"> = {
        pdfNativeOpenai: enabled,
      };
      const { io, defaults, configPath } = fixture(typed.pdfNativeOpenai);
      const before = await io.readConfigFileSnapshot();
      expect(before.valid).toBe(true);
      expect(before.config.agents?.defaults).toMatchObject(defaults);
      expect(before.config.agents?.defaults?.pdfNativeOpenai).toBe(enabled);
      await io.writeConfigFile(before.sourceConfig ?? before.config, {
        skipOutputLogs: true,
        skipRuntimeSnapshotRefresh: true,
        databaseAccess: "none",
      });
      const after = await io.readConfigFileSnapshot();
      expect(after.valid).toBe(true);
      expect(after.config.agents?.defaults).toMatchObject(defaults);
      expect(after.config.agents?.defaults?.pdfNativeOpenai).toBe(enabled);
      const stored = JSON.parse(fs.readFileSync(configPath, "utf8"));
      expect(stored.agents.defaults.pdfModel).toEqual(defaults.pdfModel);
      if (enabled === undefined) {
        expect(stored.agents.defaults).not.toHaveProperty("pdfNativeOpenai");
      } else {
        expect(stored.agents.defaults.pdfNativeOpenai).toBe(enabled);
      }
    },
  );

  it.each(["true", 1, null])("rejects non-boolean opt-in %s", async (enabled) => {
    const { io } = fixture(enabled);
    const snapshot = await io.readConfigFileSnapshot();
    expect(snapshot.valid).toBe(false);
    expect(snapshot.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "agents.defaults.pdfNativeOpenai" }),
      ]),
    );
  });
});
