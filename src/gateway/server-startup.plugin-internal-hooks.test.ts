import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createDefaultDeps } from "../cli/deps.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  triggerInternalHook,
} from "../hooks/internal-hooks.js";
import { loadOpenClawPlugins } from "../plugins/loader.js";
import { startGatewaySidecars } from "./server-startup.js";

function createSilentLogger() {
  return {
    info: (_msg: string) => {},
    warn: (_msg: string) => {},
    error: (_msg: string) => {},
    debug: (_msg: string) => {},
  };
}

async function writeTestPlugin(params: {
  dir: string;
  id: string;
  message: string;
}): Promise<void> {
  await fs.mkdir(params.dir, { recursive: true });
  await fs.writeFile(
    path.join(params.dir, "openclaw.plugin.json"),
    JSON.stringify({ id: params.id, configSchema: {} }, null, 2),
    "utf-8",
  );
  await fs.writeFile(
    path.join(params.dir, "index.ts"),
    [
      "export default function register(api) {",
      `  api.registerHook("session:start", async (event) => { event.messages.push(${JSON.stringify(params.message)}); }, { name: ${JSON.stringify(`${params.id}:session-start`)} });`,
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
}

describe("gateway startup internal hooks", () => {
  afterEach(() => {
    clearInternalHooks();
  });

  test("does not clear plugin internal hooks when loading workspace hooks", async () => {
    vi.stubEnv("OPENCLAW_SKIP_BROWSER_CONTROL_SERVER", "1");
    vi.stubEnv("OPENCLAW_SKIP_GMAIL_WATCHER", "1");
    vi.stubEnv("OPENCLAW_SKIP_CHANNELS", "1");

    vi.useFakeTimers();
    try {
      clearInternalHooks();

      const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-hook-test-"));
      try {
        const workspaceDir = path.join(tmpRoot, "workspace");
        const pluginDir = path.join(tmpRoot, "plugin");
        const pluginId = "test-plugin-internal-hooks";
        const marker = "plugin-hook-ran";

        await fs.mkdir(workspaceDir, { recursive: true });
        await writeTestPlugin({ dir: pluginDir, id: pluginId, message: marker });

        const cfg: OpenClawConfig = {
          hooks: { internal: { enabled: true } },
          plugins: {
            enabled: true,
            allow: [pluginId],
            load: { paths: [pluginDir] },
          },
        };

        // Plugin registration may register internal hooks immediately.
        const pluginRegistry = loadOpenClawPlugins({
          config: cfg,
          workspaceDir,
          cache: false,
          logger: createSilentLogger(),
        });

        await startGatewaySidecars({
          cfg,
          pluginRegistry,
          defaultWorkspaceDir: workspaceDir,
          deps: createDefaultDeps(),
          startChannels: async () => {},
          log: { warn: () => {} },
          logHooks: createSilentLogger(),
          logChannels: { info: () => {}, error: () => {} },
          logBrowser: { error: () => {} },
        });

        await vi.runAllTimersAsync();

        const event = createInternalHookEvent("session", "start", "test-session", {});
        await triggerInternalHook(event);
        expect(event.messages).toContain(marker);
      } finally {
        await fs.rm(tmpRoot, { recursive: true, force: true });
      }
    } finally {
      vi.useRealTimers();
    }
  });
});
