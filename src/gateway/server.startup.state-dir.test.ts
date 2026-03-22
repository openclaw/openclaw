import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  normalizeStateDirEnv: vi.fn((_env?: NodeJS.ProcessEnv) => undefined),
  readConfigFileSnapshot: vi.fn(async () => {
    throw new Error("__state_dir_normalized__");
  }),
}));

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    normalizeStateDirEnv: (env?: NodeJS.ProcessEnv) => mocks.normalizeStateDirEnv(env),
    readConfigFileSnapshot: () => mocks.readConfigFileSnapshot(),
  };
});

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../agents/simple-completion-transport.js", () => ({
  prepareModelForSimpleCompletion: () => null,
}));

vi.mock("../agents/anthropic-vertex-stream.js", () => ({
  createAnthropicVertexStreamFnForModel: () => null,
}));

describe("startGatewayServer state-dir normalization", () => {
  beforeEach(() => {
    mocks.normalizeStateDirEnv.mockClear();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockImplementation(async () => {
      throw new Error("__state_dir_normalized__");
    });
  });

  it("normalizes explicit state-dir overrides before reading config", async () => {
    const { startGatewayServer } = await import("./server.impl.js");

    await expect(startGatewayServer(18789)).rejects.toThrow("__state_dir_normalized__");

    expect(mocks.normalizeStateDirEnv).toHaveBeenCalledWith(process.env);
    expect(mocks.readConfigFileSnapshot).toHaveBeenCalled();
  });
});
