import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveBareResetBootstrapFileAccess } from "./session-reset-prompt.js";

const inventoryMocks = vi.hoisted(() => {
  const runtimeModel = {
    id: "dynamic-chat",
    provider: "dynamic-provider",
    api: "openai-responses",
  };
  return {
    runtimeModel,
    release: vi.fn(async () => {}),
    resolveRuntimeModelContext: vi.fn(async (_params: unknown) => ({
      modelApi: runtimeModel.api,
      runtimeModel,
    })),
    resolveInventory: vi.fn((params: Record<string, unknown>) => {
      if (!Object.hasOwn(params, "modelApi") || !Object.hasOwn(params, "runtimeModel")) {
        throw new Error("runtime model facts must be explicitly owner-published");
      }
      return {
        groups: [{ tools: [{ id: "read" }] }],
      };
    }),
  };
});

vi.mock("../../agents/tools-effective-inventory.js", () => ({
  resolveEffectiveToolInventory: inventoryMocks.resolveInventory,
  acquireEffectiveToolInventoryRuntimeModelContext: async (params: unknown) => {
    const context = await inventoryMocks.resolveRuntimeModelContext(params);
    return {
      run: <T>(project: (value: typeof context) => T): T => project(context),
      [Symbol.asyncDispose]: inventoryMocks.release,
    };
  },
}));

describe("resolveBareResetBootstrapFileAccess runtime model ownership", () => {
  beforeEach(() => {
    inventoryMocks.release.mockClear();
    inventoryMocks.resolveInventory.mockClear();
    inventoryMocks.resolveRuntimeModelContext.mockClear();
  });

  it("resolves runtime model context once and passes explicit facts to inventory", async () => {
    const modelParams = {
      cfg: {},
      agentId: "main",
      workspaceDir: "/tmp/workspace-main",
      modelProvider: "dynamic-provider",
      modelId: "dynamic-chat",
    };
    const params = { ...modelParams, sessionKey: "agent:main:main" };
    await expect(resolveBareResetBootstrapFileAccess(params)).resolves.toBe(true);
    expect(inventoryMocks.resolveRuntimeModelContext).toHaveBeenCalledExactlyOnceWith(modelParams);
    expect(inventoryMocks.resolveInventory).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        ...params,
        modelApi: inventoryMocks.runtimeModel.api,
        runtimeModel: inventoryMocks.runtimeModel,
      }),
    );
    expect(inventoryMocks.release).toHaveBeenCalledOnce();
  });

  it("releases the model context when bootstrap inventory projection fails", async () => {
    const failure = new Error("inventory projection failed");
    inventoryMocks.resolveInventory.mockImplementationOnce(() => {
      expect(inventoryMocks.release).not.toHaveBeenCalled();
      throw failure;
    });
    await expect(resolveBareResetBootstrapFileAccess({ cfg: {} })).rejects.toBe(failure);
    expect(inventoryMocks.release).toHaveBeenCalledOnce();
  });
});
