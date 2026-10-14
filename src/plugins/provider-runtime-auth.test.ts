import { beforeEach, expect, it, vi } from "vitest";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";

const mocks = vi.hoisted(() => ({ resolveProviderRuntimePlugin: vi.fn() }));

// mock-isolation: Keep plugin registry discovery outside the credential exchange boundary.
vi.mock("./provider-hook-runtime.js", () => ({
  resolveProviderRuntimePlugin: mocks.resolveProviderRuntimePlugin,
}));

// mock-isolation: Load only the real auth owner while exercising the unchanged lazy runtime facade.
vi.mock("./provider-runtime.js", async () => ({
  prepareProviderRuntimeAuth: (await import("./provider-runtime-auth.js"))
    .prepareProviderRuntimeAuth,
}));

const MODEL = makeProviderModelFixture({
  provider: "demo",
  id: "fixture-model",
  api: "openai-responses",
  baseUrl: "https://provider.example/v1",
});

beforeEach(() => mocks.resolveProviderRuntimePlugin.mockReset());

it.each([false, true])(
  "revalidates auth exchange after lazy provider loading (revoked: %s)",
  async (revoke) => {
    const lazyRuntime = await import("./provider-runtime.runtime.js");
    const prepareRuntimeAuth = vi.fn(async () => ({ apiKey: "runtime-token" }));
    mocks.resolveProviderRuntimePlugin.mockReturnValue({ prepareRuntimeAuth });
    let current = true;
    const revoked = new Error("worker claim revoked during provider loading");
    const pending = lazyRuntime.prepareProviderRuntimeAuth({
      provider: "demo",
      assertCurrent: () => {
        if (!current) {
          throw revoked;
        }
      },
      context: {
        env: process.env,
        provider: "demo",
        modelId: MODEL.id,
        model: MODEL,
        apiKey: "provider-source-token",
        authMode: "token",
      },
    });
    expect(prepareRuntimeAuth).not.toHaveBeenCalled();
    current = !revoke;
    if (revoke) {
      await expect(pending).rejects.toBe(revoked);
      expect(prepareRuntimeAuth).not.toHaveBeenCalled();
    } else {
      await expect(pending).resolves.toEqual({ apiKey: "runtime-token" });
      expect(prepareRuntimeAuth).toHaveBeenCalledOnce();
    }
  },
);
