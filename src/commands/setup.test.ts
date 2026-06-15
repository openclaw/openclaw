// Setup command tests cover the baseline compatibility path used by bare --skip-ui.
import fs from "node:fs/promises";
import path from "node:path";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { setupCommand } from "./setup.js";

function createSetupDeps(home: string) {
  const configPath = path.join(home, ".openclaw", "openclaw.json");
  return {
    createConfigIO: () => ({ configPath }),
    defaultAgentWorkspaceDir: path.join(home, ".openclaw", "workspace"),
    ensureAgentWorkspace: vi.fn(async (params: { dir: string }) => ({ dir: params.dir })),
    formatConfigPath: (value: string) => value,
    mkdir: vi.fn(async () => {}),
    resolveSessionTranscriptsDir: vi.fn(() => path.join(home, ".openclaw", "sessions")),
    replaceConfigFile: vi.fn(async ({ nextConfig }: { nextConfig: unknown }) => {
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(nextConfig, null, 2));
    }),
  };
}

function createRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

describe("setupCommand", () => {
  it("writes only baseline workspace and local Gateway mode defaults", async () => {
    await withTempHome(async (home) => {
      const deps = createSetupDeps(home);
      const workspace = path.join(home, "custom-workspace");

      await setupCommand({ workspace }, createRuntime(), deps);

      expect(
        JSON.parse(await fs.readFile(path.join(home, ".openclaw", "openclaw.json"), "utf-8")),
      ).toStrictEqual({
        agents: {
          defaults: {
            workspace,
          },
        },
        gateway: {
          mode: "local",
        },
      });
      expect(deps.ensureAgentWorkspace).toHaveBeenCalledWith({
        dir: workspace,
        ensureBootstrapFiles: true,
        skipOptionalBootstrapFiles: undefined,
      });
      expect(deps.mkdir).toHaveBeenCalledOnce();
    });
  });

  it("does not rewrite an existing baseline setup", async () => {
    await withTempHome(async (home) => {
      const deps = createSetupDeps(home);
      const configDir = path.join(home, ".openclaw");
      const configPath = path.join(configDir, "openclaw.json");
      const workspace = path.join(home, "existing-workspace");
      const config = {
        agents: {
          defaults: {
            workspace,
          },
        },
        gateway: {
          mode: "local",
        },
      };
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(configPath, JSON.stringify(config, null, 2));

      await setupCommand(undefined, createRuntime(), deps);

      expect(deps.replaceConfigFile).not.toHaveBeenCalled();
      expect(JSON.parse(await fs.readFile(configPath, "utf-8"))).toStrictEqual(config);
    });
  });
});
