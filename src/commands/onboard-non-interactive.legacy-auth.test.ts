import fs from "node:fs/promises";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { loadPersistedSharedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { runNonInteractiveSetup } from "./onboard-non-interactive.js";

it("migrates wrapper credentials before onboarding and archives a recreated legacy file", async () => {
  await withOpenClawTestState({ prefix: "onboard-legacy-auth-" }, async (state) => {
    const authPath = path.join(state.agentDir(), "auth-profiles.json");
    const legacy = JSON.stringify({
      version: 1,
      profiles: {
        "anthropic:default": { type: "api_key", provider: "anthropic", key: "synthetic-new-key" },
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "synthetic-other-key",
        },
      },
    });
    await fs.mkdir(state.agentDir(), { recursive: true });
    const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
    for (let run = 0; run < 2; run += 1) {
      await fs.writeFile(authPath, legacy);
      await runNonInteractiveSetup(
        {
          nonInteractive: true,
          acceptRisk: true,
          authChoice: "apiKey",
          anthropicApiKey: "synthetic-new-key",
          gatewayBind: "loopback",
          gatewayAuth: "token",
          gatewayToken: "synthetic-gateway-token",
          installDaemon: false,
          skipHealth: true,
          workspace: state.workspaceDir,
        },
        runtime,
      );
      expect(runtime.exit).not.toHaveBeenCalled();
      await expect(fs.access(authPath)).rejects.toMatchObject({ code: "ENOENT" });
      const archives = (await fs.readdir(state.agentDir())).filter((name) =>
        name.startsWith("auth-profiles.json.migrated-"),
      );
      expect(archives.length).toBeGreaterThan(0);
      expect(await fs.readFile(path.join(state.agentDir(), archives[0]!), "utf8")).toBe(legacy);
      const store = loadPersistedSharedAuthProfileStore(state.env);
      expect(store?.profiles["openrouter:default"]).toMatchObject({ key: "synthetic-other-key" });
      expect(Object.values(store?.profiles ?? {})).toContainEqual(
        expect.objectContaining({ provider: "anthropic", key: "synthetic-new-key" }),
      );
    }
  });
});
