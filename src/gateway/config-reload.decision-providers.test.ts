import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createPluginRecord } from "../plugins/loader-records.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { buildGatewayReloadPlan } from "./config-reload-plan.js";

function configured(baseUrl: string): OpenClawConfig {
  return {
    models: {
      providers: {
        custom: {
          type: "decision",
          decisionProvider: "adapter",
          baseUrl,
          models: [],
        },
      },
    },
  };
}

afterEach(() => resetPluginRuntimeStateForTest());

describe("configured decision provider reload", () => {
  it("replaces the adapter owner when its configured aliases change", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push(
      createPluginRecord({
        id: "adapter-plugin",
        source: "/synthetic/adapter.ts",
        origin: "global",
        enabled: true,
        configSchema: false,
        contracts: { decisionProviders: ["adapter"] },
      }),
    );
    setActivePluginRegistry(registry);
    const plan = buildGatewayReloadPlan(["models.providers.custom.baseUrl"], {
      previousConfig: configured("https://first.example/v1"),
      candidateConfig: configured("https://second.example/v1"),
    });
    expect(plan.restartGateway).toBe(false);
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.reloadPluginIds).toEqual(new Set(["adapter-plugin"]));
    expect(plan.reloadPluginPaths).toEqual(["models.providers.custom.baseUrl"]);
  });

  it.each(["add", "remove"])("reloads plugin registration on alias %s", (operation) => {
    const decisions = configured("https://decisions.example/v1");
    const plan = buildGatewayReloadPlan(["models.providers.custom"], {
      previousConfig: operation === "add" ? {} : decisions,
      candidateConfig: operation === "remove" ? {} : decisions,
    });
    expect(plan.reloadPlugins).toBe(true);
    expect(plan.restartGateway).toBe(false);
  });

  it("keeps ordinary chat-only model edits on their existing reload path", () => {
    const config = configured("https://decisions.example/v1");
    const plan = buildGatewayReloadPlan(["models.providers.chat.baseUrl"], {
      previousConfig: config,
      candidateConfig: { ...config, agents: { defaults: { model: "chat/small" } } },
    });
    expect(plan.reloadPlugins).toBe(false);
    expect(plan.restartGateway).toBe(false);
  });
});
