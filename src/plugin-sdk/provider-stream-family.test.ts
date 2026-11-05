import { beforeEach, describe, expect, it, vi } from "vitest";
const { loadSurface, factory } = vi.hoisted(() => ({ loadSurface: vi.fn(), factory: vi.fn() }));
vi.mock("./facade-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./facade-runtime.js")>()),
  loadBundledPluginPublicSurfaceModuleSync: loadSurface,
}));
import * as providerStreamFamily from "./provider-stream-family.js";
import * as providerStream from "./provider-stream.js";

describe("provider-stream-family compatibility exports", () => {
  it("preserves the Moonshot shortcut used by published providers", () => {
    const value = providerStreamFamily.MOONSHOT_THINKING_STREAM_HOOKS;

    expect(value).toHaveProperty("wrapStreamFn");
    expect(value).toBe(providerStream.MOONSHOT_THINKING_STREAM_HOOKS);
  });
});

describe("closed provider-native stream factory", () => {
  const params = {
    api: "ollama" as const,
    baseUrl: "https://router.example/prefix",
    headers: { Authorization: "Bearer synthetic-proxy-key" },
    transport: {
      requestUrl: "https://router.example/prefix/v1/proxy/ollama/chat",
      bodyMode: "manifest" as const,
    },
  };
  beforeEach(() => {
    loadSurface.mockReset();
    factory.mockReset();
  });
  it("loads only the Ollama runtime factory and preserves its arguments", async () => {
    const stream = vi.fn();
    factory.mockReturnValue(stream);
    loadSurface.mockReturnValue({ createOllamaStreamFn: factory });
    expect(await providerStreamFamily.createProviderNativeStreamFn(params)).toBe(stream);
    expect(loadSurface).toHaveBeenCalledExactlyOnceWith({
      dirName: "ollama",
      artifactBasename: "runtime-api.js",
    });
    expect(factory).toHaveBeenCalledExactlyOnceWith(
      params.baseUrl,
      params.headers,
      params.transport,
    );
  });
  it("rejects a foreign API before loading any surface", async () => {
    const foreign = { ...params };
    Object.defineProperty(foreign, "api", { value: "openai-completions" });
    await expect(providerStreamFamily.createProviderNativeStreamFn(foreign)).rejects.toThrow(
      "Unsupported provider-native stream API",
    );
    expect(loadSurface).not.toHaveBeenCalled();
  });
  it("rejects a missing factory without invoking another export", async () => {
    const configured = vi.fn();
    loadSurface.mockReturnValue({ createConfiguredOllamaStreamFn: configured });
    await expect(providerStreamFamily.createProviderNativeStreamFn(params)).rejects.toThrow(
      "missing createOllamaStreamFn",
    );
    expect(configured).not.toHaveBeenCalled();
  });
  it("preserves the native surface refusal without fallback", async () => {
    const refusal = new Error("Ollama runtime surface unavailable");
    loadSurface.mockImplementation(() => {
      throw refusal;
    });
    await expect(providerStreamFamily.createProviderNativeStreamFn(params)).rejects.toBe(refusal);
    expect(loadSurface).toHaveBeenCalledTimes(1);
    expect(factory).not.toHaveBeenCalled();
  });
});
