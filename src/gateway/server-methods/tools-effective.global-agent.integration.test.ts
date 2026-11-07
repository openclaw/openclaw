import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { installGatewayTestHooks, testState, writeSessionStore } from "../test-helpers.js";
import { getGatewayConfigModule, sessionStoreEntry } from "../test/server-sessions.test-helpers.js";
import { toolsEffectiveInventoryMocks as inventoryMocks } from "./tools-effective.test-support.js";

const { toolsEffectiveHandlers, testing } = await import("./tools-effective.js");

installGatewayTestHooks();

describe("tools.effective global agent integration", () => {
  let mainStorePath = "";
  let workStorePath = "";
  let getRuntimeConfig: Awaited<ReturnType<typeof getGatewayConfigModule>>["getRuntimeConfig"];

  async function reloadConfig() {
    const configModule = await getGatewayConfigModule();
    configModule.clearRuntimeConfigSnapshot();
    configModule.clearConfigCache();
    getRuntimeConfig = configModule.getRuntimeConfig;
  }

  async function requestTools(sessionKey = "global") {
    const respond = vi.fn();
    await expectDefined(
      toolsEffectiveHandlers["tools.effective"],
      "tools.effective handler",
    )({
      params: { sessionKey, agentId: "work" },
      respond: respond as never,
      context: { getRuntimeConfig } as never,
      client: null,
      req: { type: "req", id: "tools-effective", method: "tools.effective" },
      isWebchatConnect: () => false,
    });
    return respond;
  }

  function expectInventory(modelProvider: string, modelId: string) {
    expect(inventoryMocks.resolveEffectiveToolInventory).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: "work", sessionKey: "global", modelProvider, modelId }),
    );
  }

  async function seedStores(global = true) {
    const stateDir = process.env.OPENCLAW_STATE_DIR;
    if (!stateDir) {
      throw new Error("OPENCLAW_STATE_DIR is required");
    }
    const dir = path.join(stateDir, "session-stores", `tools-effective-${global}-${Date.now()}`);
    const storeTemplate = path.join(dir, "{agentId}", "sessions.json");
    testState.sessionStorePath = storeTemplate;
    testState.sessionConfig = global ? { scope: "global" } : undefined;
    testState.agentConfig = undefined;
    testState.agentsConfig = { entries: { main: {}, work: {} } };
    mainStorePath = storeTemplate.replace("{agentId}", "main");
    workStorePath = storeTemplate.replace("{agentId}", "work");
    await reloadConfig();
  }

  async function writeGlobalStore(agentId: "main" | "work", model: string, override = false) {
    await writeSessionStore({
      storePath: agentId === "main" ? mainStorePath : workStorePath,
      ...(agentId === "work" ? { agentId } : {}),
      entries: {
        global: sessionStoreEntry(`sess-${agentId}-global`, {
          modelProvider: "openai",
          model,
          ...(override ? { providerOverride: "openai", modelOverride: model } : {}),
        }),
      },
    });
  }

  beforeEach(async () => {
    testing.resetToolsEffectiveCacheForTest();
    vi.clearAllMocks();
    await seedStores();
  });

  it("resolves tools.effective for global session scoped to a non-default agent store", async () => {
    await writeGlobalStore("main", "main-model");
    await writeGlobalStore("work", "work-model", true);
    const respond = await requestTools();
    expect(respond.mock.calls[0]).toEqual([
      true,
      expect.objectContaining({ agentId: "work" }),
      undefined,
    ]);
    expectInventory("openai", "work-model");
  });

  it("uses the hot-reloaded agent default instead of stale runtime identity", async () => {
    testState.agentConfig = { model: { primary: "openai/stale-model" } };
    await reloadConfig();
    await writeGlobalStore("work", "stale-model");

    const before = await requestTools();
    expect(before.mock.calls[0]?.[0]).toBe(true);
    expectInventory("openai", "stale-model");

    testState.agentConfig = { model: { primary: "anthropic/current-model" } };
    await reloadConfig();
    const after = await requestTools();
    expect(after.mock.calls[0]?.[0]).toBe(true);
    expectInventory("anthropic", "current-model");
  });

  // The global agent override must not override ownership of a non-global key.
  it("rejects a mismatched configured agent for a non-global session key", async () => {
    await seedStores(false);

    await writeSessionStore({
      storePath: mainStorePath,
      entries: {
        "agent:main:abc": sessionStoreEntry("sess-main-agent", {
          modelProvider: "openai",
          model: "main-model",
        }),
      },
    });

    const respond = await requestTools("agent:main:abc");
    expect(respond.mock.calls[0]).toEqual([
      false,
      undefined,
      expect.objectContaining({ message: 'agent "work" does not match session key agent "main"' }),
    ]);
    expect(inventoryMocks.resolveEffectiveToolInventory).not.toHaveBeenCalled();
  });
});
