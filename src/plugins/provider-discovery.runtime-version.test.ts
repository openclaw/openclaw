import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerAgentHarness } from "../agents/harness/registry.js";
import type { AgentHarness, AgentHarnessModelCatalogResult } from "../agents/harness/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import type { ProviderCatalogContext } from "./provider-catalog.types.js";
import { runProviderCatalog } from "./provider-discovery.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "./runtime.js";
import type { ProviderPlugin } from "./types.js";

describe("provider catalog runtime metadata", () => {
  let snapshot: ReturnType<typeof captureActivePluginRegistrySnapshot>;
  beforeEach(() => {
    snapshot = captureActivePluginRegistrySnapshot();
    setActivePluginRegistry(createEmptyPluginRegistry());
  });
  afterEach(() => restoreActivePluginRegistrySnapshot(snapshot));

  function harness(loadModelCatalog: NonNullable<AgentHarness["loadModelCatalog"]>) {
    registerAgentHarness({
      id: "test-native",
      label: "Test native",
      supports: () => ({ supported: true }),
      runAttempt: async () => {
        throw new Error("Catalog lookup must not run inference");
      },
      loadModelCatalog,
    });
  }
  function discover(run: NonNullable<ProviderPlugin["catalog"]>["run"], isActive?: () => boolean) {
    return runProviderCatalog({
      provider: { id: "test-provider", label: "Test", auth: [], catalog: { run } },
      config: { agents: { entries: { chosen: {} } } },
      agentDir: "/fixture/agent",
      workspaceDir: "/fixture/workspace",
      env: {},
      resolveProviderApiKey: () => ({ apiKey: undefined }),
      resolveProviderAuth: () => ({ apiKey: undefined, mode: "none", source: "none" }),
      isActive,
    });
  }
  it("forwards the exact account scope and returns the selected runtime version without inference", async () => {
    const load = vi.fn(async () => ({ entries: [], runtimeVersion: "0.161.0" }));
    harness(load);
    await discover(async (ctx) => {
      expect(await ctx.resolveRuntimeVersion?.("test-native", { authProfileId: "account-b" })).toBe(
        "0.161.0",
      );
      return null;
    });
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "chosen",
        authProfileId: "account-b",
        agentDir: "/fixture/agent",
        workspaceDir: "/fixture/workspace",
      }),
    );
  });
  it("returns no invented version for unavailable or legacy catalogs", async () => {
    harness(async () => []);
    await discover(async (ctx) => {
      expect(await ctx.resolveRuntimeVersion?.("missing-runtime")).toBeUndefined();
      expect(await ctx.resolveRuntimeVersion?.("test-native")).toBeUndefined();
      return null;
    });
  });
  it.each(["inactive", "replaced"] as const)(
    "drops a result if its owner becomes %s during acquisition",
    async (reason) => {
      let active = true;
      const entered = createDeferredCore();
      const release = createDeferredCore<AgentHarnessModelCatalogResult>();
      harness(async () => {
        entered.resolve();
        return await release.promise;
      });
      let observed: string | undefined = "unsettled";
      const pending = discover(
        async (ctx) => {
          observed = await ctx.resolveRuntimeVersion?.("test-native");
          return null;
        },
        () => active,
      );
      try {
        await entered.promise;
        if (reason === "inactive") {
          active = false;
        } else {
          harness(async () => ({ entries: [], runtimeVersion: "0.162.0" }));
        }
      } finally {
        release.resolve({ entries: [], runtimeVersion: "0.161.0" });
        await pending;
      }
      expect(observed).toBeUndefined();
    },
  );
  it("revokes a retained callback when the catalog operation settles", async () => {
    const load = vi.fn(async () => ({ entries: [], runtimeVersion: "0.161.0" }));
    harness(load);
    let retained: ProviderCatalogContext["resolveRuntimeVersion"];
    await discover(async (ctx) => {
      retained = ctx.resolveRuntimeVersion;
      return null;
    });
    expect(await retained?.("test-native")).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
  });
});
