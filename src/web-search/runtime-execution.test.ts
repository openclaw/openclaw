import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolAuthorizationError } from "../agents/tool-input-error.js";
import { clearRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type {
  PluginWebSearchProviderEntry,
  WebSearchProviderToolDefinition,
} from "../plugins/web-provider-types.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { WebSearchProviderError } from "./runtime-error.js";
import { runWebSearch } from "./runtime.js";

const { providersMock } = vi.hoisted(() => ({
  providersMock: vi.fn<() => PluginWebSearchProviderEntry[]>(() => []),
}));
// mock-isolation: Synthetic provider descriptors do not admit installed plugins or machine discovery.
vi.mock("../plugins/bundled-discovery-state.js", () => ({
  prepareBundledDiscoveryMode: async () => () => {},
  readBundledDiscoveryModeMemoized: () => undefined,
}));
vi.mock("../plugins/web-search-providers.runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/web-search-providers.runtime.js")>()),
  resolvePluginWebSearchProviders: providersMock,
  resolveRuntimeWebSearchProviders: providersMock,
}));

beforeEach(() => clearRuntimeConfigSnapshot());
afterEach(() => {
  clearRuntimeConfigSnapshot();
  providersMock.mockReset();
});

function search(
  providers: PluginWebSearchProviderEntry[],
  options: Pick<Parameters<typeof runWebSearch>[0], "signal" | "assertCurrent"> = {},
) {
  providersMock.mockReturnValue(
    providers.map((provider, autoDetectOrder) => ({
      ...provider,
      autoDetectOrder,
      getConfiguredCredentialValue: () => "fixture-credential",
      getCredentialValue: () => "fixture-credential",
    })),
  );
  return runWebSearch({
    config: {},
    preferInputConfig: true,
    authStore: { version: 1, profiles: {} },
    runtimeWebSearch: { providerSource: "auto-detect", diagnostics: [] },
    args: { query: "synthetic query" },
    ...options,
  });
}

function candidate(id: string, execute: WebSearchProviderToolDefinition["execute"]) {
  return createWebSearchTestProvider({
    id,
    pluginId: "fixture-search",
    credentialPath: `plugins.entries.fixture-search.config.${id}`,
    createTool: () => ({ description: id, parameters: {}, execute }),
  });
}

describe("web search provider execution", () => {
  it.each([
    new ToolAuthorizationError("Search is not authorized for this run"),
    new SecretSurfaceUnavailableError({
      ownerKind: "capability",
      ownerId: "web-search:first",
      state: "unavailable",
      paths: [],
      refKeys: [],
      reason: "credential unavailable",
    }),
  ])("does not fall back after trusted $name preflight denial", async (failure) => {
    const fallback = vi.fn(async () => ({ results: [] }));
    const result = search([
      candidate("first", async () => {
        throw failure;
      }),
      candidate("fallback", fallback),
    ]);
    await expect(result).rejects.toBe(failure);
    expect(fallback).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "retains chronology across structured and thrown errors (structured first: %s)",
    async (structuredFirst) => {
      const thrown = new Error("ordinary provider failure");
      const missingKey = vi.fn(async () => ({ error: "missing_fixture_api_key" }));
      const fail = vi.fn(async () => {
        throw thrown;
      });
      const result = search([
        candidate("first", structuredFirst ? missingKey : fail),
        candidate("second", structuredFirst ? fail : missingKey),
      ]);
      if (structuredFirst) {
        await expect(result).rejects.toThrow(
          'web_search provider "first" returned missing_fixture_api_key',
        );
      } else {
        await expect(result).rejects.toMatchObject({ provider: "first", cause: thrown });
      }
      expect(missingKey).toHaveBeenCalledOnce();
      expect(fail).toHaveBeenCalledOnce();
    },
  );

  it("returns the selected provider's missing-credential payload after fallback is exhausted", async () => {
    const payload = { error: "missing_fixture_api_key", message: "set FIXTURE_KEY" };
    const failure = await search([
      candidate("first", async () => payload),
      candidate("second", async () => ({ error: "missing_other_api_key" })),
    ]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(WebSearchProviderError);
    if (!(failure instanceof WebSearchProviderError)) {
      throw new Error("Expected a provider-attributed search failure");
    }
    expect(failure.toResult()).toEqual({
      provider: "first",
      result: payload,
    });
  });

  it("gives cancellation precedence over a saved failure and later cleanup error", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    await expect(
      search(
        [
          candidate("first", async () => {
            throw new Error("first provider failure");
          }),
          candidate("second", async () => {
            controller.abort(reason);
            throw new Error("second provider cleanup failure");
          }),
        ],
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
  });

  it.each(["result", "failure", "cancelled"] as const)(
    "does not fall back or return stale work after authority ends during a provider %s",
    async (completion) => {
      const controller = new AbortController();
      const denial = new Error("search caller no longer authorized");
      const cancellation = new Error("search caller cancelled");
      let current = true;
      const fallback = vi.fn(async () => ({ results: [] }));
      const pending = search(
        [
          candidate("first", async () => {
            await Promise.resolve();
            current = false;
            if (completion === "cancelled") {
              controller.abort(cancellation);
            }
            if (completion !== "result") {
              throw new Error("provider cleanup failed");
            }
            return { results: [] };
          }),
          candidate("fallback", fallback),
        ],
        {
          signal: controller.signal,
          assertCurrent: () => {
            if (!current) {
              throw denial;
            }
          },
        },
      );
      await expect(pending).rejects.toBe(completion === "cancelled" ? cancellation : denial);
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it("starts no provider factory when the caller is already cancelled", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled before search");
    controller.abort(reason);
    const createTool = vi.fn(() => ({
      description: "unused",
      parameters: {},
      execute: async () => ({}),
    }));
    await expect(
      search(
        [
          createWebSearchTestProvider({
            id: "unused",
            pluginId: "fixture-search",
            credentialPath: "plugins.entries.fixture-search.config.unused",
            createTool,
          }),
        ],
        {
          signal: controller.signal,
        },
      ),
    ).rejects.toBe(reason);
    expect(createTool).not.toHaveBeenCalled();
  });
});
