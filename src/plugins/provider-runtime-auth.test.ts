import { beforeEach, expect, it, vi } from "vitest";
import { configForProviders } from "../agents/model-auth.fixtures.test-support.js";
import { makeProviderModelFixture } from "../agents/test-helpers/provider-model-fixture.js";
import { createDeferredCore } from "../shared/deferred.js";
import {
  attachProviderAuthAuthority,
  assertProviderAuthAuthority,
} from "./provider-auth-authority.js";
import {
  prepareProviderRuntimeAuth,
  UnsupportedProviderRuntimeAuthCapabilityError,
} from "./provider-runtime-auth.js";
import type {
  ProviderPrepareRuntimeAuthContext,
  ProviderPrepareRuntimeAuthContextV2,
} from "./types.js";

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

it.each(["legacy", "v2"] as const)(
  "skips %s credential exchange for explicit no-auth",
  async (version) => {
    const lazyRuntime = await import("./provider-runtime.runtime.js");
    const prepareRuntimeAuth = vi.fn(async () => ({ apiKey: "runtime-token" }));
    mocks.resolveProviderRuntimePlugin.mockReturnValue(
      version === "legacy" ? { prepareRuntimeAuth } : { prepareRuntimeAuthV2: prepareRuntimeAuth },
    );
    await expect(
      lazyRuntime.prepareProviderRuntimeAuth({
        provider: "demo",
        config: configForProviders({
          demo: { auth: "none", api: "openai-completions", baseUrl: MODEL.baseUrl, models: [] },
        }),
        context: {
          ...(version === "v2" ? { capability: "decision" as const } : {}),
          env: process.env,
          provider: "demo",
          modelId: MODEL.id,
          model: { ...MODEL, api: "openai-completions" },
          apiKey: "synthetic-no-auth-marker",
          authMode: "api-key",
        },
      }),
    ).resolves.toBeUndefined();
    expect(mocks.resolveProviderRuntimePlugin).not.toHaveBeenCalled();
    expect(prepareRuntimeAuth).not.toHaveBeenCalled();
  },
);

const LEGACY_CONTEXT: ProviderPrepareRuntimeAuthContext = {
  env: {},
  provider: "demo",
  modelId: MODEL.id,
  model: MODEL,
  apiKey: "provider-source-token",
  authMode: "token",
};

const DECISION_CONTEXT: ProviderPrepareRuntimeAuthContextV2 = {
  ...LEGACY_CONTEXT,
  capability: "decision",
  model: { id: MODEL.id, provider: MODEL.provider },
};

it("preserves the complete model and context for a legacy chat exchange", async () => {
  const prepare = vi.fn(async () => ({ apiKey: "runtime-token" }));
  mocks.resolveProviderRuntimePlugin.mockReturnValue({ prepareRuntimeAuth: prepare });
  await prepareProviderRuntimeAuth({ provider: "demo", context: LEGACY_CONTEXT });
  expect(prepare).toHaveBeenCalledExactlyOnceWith(LEGACY_CONTEXT);
});

it.each(["chat", "decision"] as const)(
  "prefers V2 for %s without calling both hooks",
  async (capability) => {
    const legacy = vi.fn();
    const prepare = vi.fn(async () => ({ apiKey: "runtime-token" }));
    mocks.resolveProviderRuntimePlugin.mockReturnValue({
      prepareRuntimeAuth: legacy,
      prepareRuntimeAuthV2: prepare,
    });
    const context = capability === "chat" ? LEGACY_CONTEXT : DECISION_CONTEXT;
    await expect(prepareProviderRuntimeAuth({ provider: "demo", context })).resolves.toEqual({
      apiKey: "runtime-token",
    });
    expect(prepare).toHaveBeenCalledExactlyOnceWith({ ...context, capability });
    expect(legacy).not.toHaveBeenCalled();
  },
);

it("rejects a minimal model at a legacy exchange rather than skipping authentication", async () => {
  const legacy = vi.fn();
  mocks.resolveProviderRuntimePlugin.mockReturnValue({ prepareRuntimeAuth: legacy });
  await expect(
    prepareProviderRuntimeAuth({ provider: "demo", context: DECISION_CONTEXT }),
  ).rejects.toBeInstanceOf(UnsupportedProviderRuntimeAuthCapabilityError);
  expect(legacy).not.toHaveBeenCalled();
});

it.each(["caller", "credential", "current"] as const)(
  "revalidates %s ownership after a pending V2 exchange",
  async (owner) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    let current = true;
    const revoked = new Error("fixture exchange authority revoked");
    const assertCurrent = () => {
      if (!current) {
        throw revoked;
      }
    };
    const prepare = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return { apiKey: "runtime-token" };
    });
    mocks.resolveProviderRuntimePlugin.mockReturnValue({ prepareRuntimeAuthV2: prepare });
    const pending = prepareProviderRuntimeAuth({
      provider: "demo",
      ...(owner === "caller" ? { assertCurrent } : {}),
      context: {
        ...DECISION_CONTEXT,
        model: attachProviderAuthAuthority(
          DECISION_CONTEXT.model,
          owner === "caller" ? undefined : assertCurrent,
        ),
      },
    });
    await entered.promise;
    current = owner === "current";
    release.resolve();
    if (current) {
      const result = await pending;
      expect(result).toMatchObject({ apiKey: "runtime-token" });
      current = false;
      expect(() => assertProviderAuthAuthority(result)).toThrow(revoked);
    } else {
      await expect(pending).rejects.toBe(revoked);
    }
    expect(prepare).toHaveBeenCalledOnce();
  },
);

it.each([
  { version: "legacy", revoke: false },
  { version: "legacy", revoke: true },
  { version: "v2", revoke: false },
  { version: "v2", revoke: true },
])(
  "revalidates $version auth exchange after lazy provider loading (revoked: $revoke)",
  async ({ version, revoke }) => {
    const lazyRuntime = await import("./provider-runtime.runtime.js");
    const prepareRuntimeAuth = vi.fn(async () => ({ apiKey: "runtime-token" }));
    mocks.resolveProviderRuntimePlugin.mockReturnValue(
      version === "legacy" ? { prepareRuntimeAuth } : { prepareRuntimeAuthV2: prepareRuntimeAuth },
    );
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
