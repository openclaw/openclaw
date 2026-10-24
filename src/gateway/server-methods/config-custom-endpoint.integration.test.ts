import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import type { ConfigFileSnapshot } from "../../config/config.js";
import * as updateStartup from "../../infra/update-startup.js";
import { createCatalogModel, createCatalogState } from "./models-catalog-fixture.test-support.js";
import { modelsTestConfig, startModelsGateway } from "./models-integration.test-support.js";

it(
  "persists and clears provider branding through the local config RPC without changing model defaults",
  { timeout: 120_000 },
  async () => {
    const createUpdateCheck = updateStartup.createGatewayUpdateCheck;
    vi.spyOn(updateStartup, "createGatewayUpdateCheck").mockImplementation((params) => ({
      ...createUpdateCheck(params),
      start: () => {},
    }));
    await using state = await createCatalogState("custom-provider-branding");
    const token = "custom-provider-gateway-fixture-token";
    const cfg = modelsTestConfig(state, token, {
      update: { checkOnStart: false },
      agents: { defaults: { model: "existing-fixture/chat" } },
      models: {
        providers: {
          "existing-fixture": {
            baseUrl: "https://inference.example/v1",
            api: "openai-completions",
            auth: "none",
            models: [createCatalogModel("chat", "Existing Chat")],
          },
        },
      },
    });
    await state.writeConfig(cfg);
    state.applyEnv();
    const unexpectedRestart = vi.fn(() => {
      throw new Error("Provider branding unexpectedly requested Gateway recovery");
    });
    try {
      await using gateway = await startModelsGateway(state, cfg, token, {
        hotReloadRecovery: unexpectedRestart,
      });
      await gateway.server.startupSettled;
      const snapshot = () => gateway.client.request<ConfigFileSnapshot>("config.get", {});
      const logo = "data:image/png;base64,iVBORw0KGgo=";
      const input = {
        provider: "lab-inference",
        baseUrl: "https://inference.example/v1",
        api: "openai-completions",
        noAuth: true,
        models: [{ id: "chat", edits: { name: "Chat" } }],
      };
      await gateway.client.request("config.customEndpoint", {
        ...input,
        action: "create",
        name: "Lab inference",
        logo,
        baseHash: (await snapshot()).hash,
      });
      const saved = await snapshot();
      expect(saved.config.agents?.defaults?.model).toBe("existing-fixture/chat");
      expect(saved.config.models?.providers?.[input.provider]).toMatchObject({
        name: "Lab inference",
        logo,
        auth: "none",
      });
      expect(
        JSON.parse(await readFile(state.configPath, "utf8")).models.providers[input.provider],
      ).toMatchObject({ name: "Lab inference", logo });
      await gateway.client.request("config.customEndpoint", {
        ...input,
        action: "edit",
        models: [{ id: "chat", existingId: "chat", edits: {} }],
        name: null,
        logo: null,
        baseHash: saved.hash,
      });
      const cleared = await snapshot();
      const authored = JSON.parse(await readFile(state.configPath, "utf8"));
      expect(authored.models.providers[input.provider]).not.toHaveProperty("name");
      expect(authored.models.providers[input.provider]).not.toHaveProperty("logo");
      expect(cleared.config.agents?.defaults?.model).toEqual(saved.config.agents?.defaults?.model);
      expect(authored.models.providers[input.provider].models).toEqual([
        { id: "chat", name: "Chat" },
      ]);
      expect(unexpectedRestart).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  },
);
