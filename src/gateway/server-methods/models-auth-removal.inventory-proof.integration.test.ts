import { describe, expect, it, vi } from "vitest";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import * as authProfiles from "../../agents/auth-profiles.js";
import {
  ensureAuthProfileStoreWithoutExternalProfilesAsync,
  upsertAuthProfile,
} from "../../agents/auth-profiles.js";
import { createModelsTestState, startModelsGateway } from "./models-integration.test-support.js";

function configuredProvider(apiKey: string) {
  return {
    baseUrl: "http://127.0.0.1:9/v1",
    api: "openai-completions",
    apiKey,
    models: [{ id: "fixture-model", name: "Fixture" }],
  };
}

describe("models.authLogout committed inventory", () => {
  it("reports a profile added after the initial read", async () => {
    await using state = await createModelsTestState("models-auth-removal-proof", {
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: "0" },
    });
    const token = "inventory-proof-gateway-token";
    const cfg = {
      agents: {
        ownership: "explicit" as const,
        entries: { main: { workspace: state.workspaceDir } },
        defaults: { model: "fixture/fixture-model" },
      },
      plugins: { enabled: false },
      gateway: { mode: "local", auth: { mode: "token", token } },
      models: { providers: { fixture: configuredProvider("synthetic-inventory-proof") } },
    };
    const agentDir = resolveAgentDir({ agents: cfg.agents }, "main");
    upsertAuthProfile({
      agentDir,
      profileId: "fixture:old",
      credential: { type: "api_key", provider: "fixture", key: "synthetic-old" },
    });
    await using gateway = await startModelsGateway(state, cfg, token);
    await gateway.server.startupSettled;

    const originalListProfilesForProvider = authProfiles.listProfilesForProvider;
    let injected = false;
    const listSpy = vi
      .spyOn(authProfiles, "listProfilesForProvider")
      .mockImplementation((store, provider) => {
        const profiles = originalListProfilesForProvider(store, provider);
        if (!injected && provider === "fixture" && profiles.includes("fixture:old")) {
          injected = true;
          upsertAuthProfile({
            agentDir,
            profileId: "fixture:new",
            credential: { type: "api_key", provider: "fixture", key: "synthetic-new" },
          });
        }
        return profiles;
      });
    try {
      const result = await gateway.client.request<{
        provider: string;
        removedProfiles: string[];
      }>("models.authLogout", { provider: "fixture", agentId: "main" });

      expect(result).toMatchObject({
        provider: "fixture",
        removedProfiles: ["fixture:old", "fixture:new"],
      });
      expect(injected).toBe(true);
      await expect(
        ensureAuthProfileStoreWithoutExternalProfilesAsync(agentDir),
      ).resolves.toMatchObject({
        profiles: {},
      });
    } finally {
      listSpy.mockRestore();
    }
  });
});
