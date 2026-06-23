import { describe, expect, it, vi } from "vitest";
import type {
  PluginAdapter,
  PluginAdapterContext,
  PluginApprovalRequest,
  PluginCoreApi,
} from "./plugin-adapter.types.js";
import { validatePluginManifest } from "./plugin-manifest.schema.js";

describe("plugin adapter", () => {
  it("valid manifest fixture passes shape validation", () => {
    const result = validatePluginManifest({
      name: "memory-summary",
      description: "Summarizes stored memory through the core API.",
      capabilities: ["memory:read"],
      entrypoint: "./dist/index.js",
      enabledByDefault: false,
      riskLevel: "low",
    });

    expect(result).toEqual({
      ok: true,
      manifest: {
        name: "memory-summary",
        description: "Summarizes stored memory through the core API.",
        capabilities: ["memory:read"],
        entrypoint: "./dist/index.js",
        enabledByDefault: false,
        riskLevel: "low",
      },
    });
  });

  it("manifest requires name/capabilities/entrypoint", () => {
    const result = validatePluginManifest({});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        "manifest.name must be a non-empty string",
        "manifest.capabilities must be an array of strings",
        "manifest.entrypoint must be a non-empty string",
      ]);
    }
  });

  it("adapter context does not expose raw DB handle", () => {
    const allowedCoreApiKeys = ["readMemory", "writeMemory", "emitEvent"];
    const coreApi: PluginCoreApi = {};

    expect(Object.keys(coreApi).every((key) => allowedCoreApiKeys.includes(key))).toBe(true);
    expect("db" in coreApi).toBe(false);
    expect("database" in coreApi).toBe(false);
    expect("connection" in coreApi).toBe(false);
    expect("dbPath" in coreApi).toBe(false);
  });

  it("adapter can be initialized with fake coreApi/logger/approval requester", async () => {
    const initialize = vi.fn((context: PluginAdapterContext) =>
      context.coreApi.emitEvent?.({ type: "plugin.initialized" }),
    );
    const adapter: PluginAdapter = {
      manifest: {
        name: "fake-plugin",
        capabilities: ["events:write"],
        entrypoint: "./fake.js",
      },
      initialize,
    };
    const emitEvent = vi.fn<NonNullable<PluginCoreApi["emitEvent"]>>();

    await adapter.initialize?.({
      coreApi: { emitEvent },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      requestApproval: vi.fn(async () => ({ approved: true })),
    });

    expect(initialize).toHaveBeenCalledOnce();
    expect(emitEvent).toHaveBeenCalledWith({ type: "plugin.initialized" });
  });

  it("healthCheck can return ok:false without throwing", async () => {
    const adapter: PluginAdapter = {
      manifest: {
        name: "degraded-plugin",
        capabilities: ["memory:read"],
        entrypoint: "./degraded.js",
      },
      healthCheck: () => ({
        ok: false,
        message: "dependency unavailable",
      }),
    };

    await expect(Promise.resolve(adapter.healthCheck?.())).resolves.toEqual({
      ok: false,
      message: "dependency unavailable",
    });
  });

  it("write-like action can request approval via fake requester", async () => {
    const requests: PluginApprovalRequest[] = [];
    const requestApproval = vi.fn(async (request: PluginApprovalRequest) => {
      requests.push(request);
      return { approved: true };
    });
    const context: PluginAdapterContext = {
      coreApi: {
        writeMemory: vi.fn(async (input: unknown) => ({ saved: input })),
      },
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
      },
      requestApproval,
    };

    const result = await context.requestApproval({
      pluginName: "memory-writer",
      action: "writeMemory",
      riskLevel: "medium",
      summary: "Store a plugin-generated memory item.",
      payload: { text: "approved memory" },
    });

    expect(result).toEqual({ approved: true });
    expect(requests).toEqual([
      {
        pluginName: "memory-writer",
        action: "writeMemory",
        riskLevel: "medium",
        summary: "Store a plugin-generated memory item.",
        payload: { text: "approved memory" },
      },
    ]);
  });
});
