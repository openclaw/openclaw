import { expect, it, vi, type Mock } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runCap, runCapability } from "./capability-cli.test-harness.js";

export function registerWebCapabilityCliTests({
  mocks,
  firstJsonOutput,
  runtimeErrorMessages,
}: {
  mocks: {
    loadConfig: Mock;
    resolveCommandConfigWithSecrets: Mock;
    isWebSearchProviderConfigured: Mock;
    isWebFetchProviderConfigured: Mock;
    getCapabilityWebSearchCommandSecretTargets: Mock;
    getCapabilityWebFetchCommandSecretTargets: Mock;
    runtime: { writeJson: Mock; error: Mock; exit: Mock };
  };
  firstJsonOutput: () => Record<string, unknown> | undefined;
  runtimeErrorMessages: () => string[];
}): void {
  it.each([true, false])(
    "inspects web provider state with explicit agent selection %s",
    async (scoped) => {
      mocks.loadConfig.mockReturnValue(
        scoped
          ? { agents: { ownership: "explicit", entries: { alpha: {}, beta: {} } } }
          : {
              tools: { web: { search: { provider: "gemini" }, fetch: { provider: "firecrawl" } } },
            },
      );
      const provider = { id: "openai", envVars: ["OPENAI_API_KEY"], requiresCredential: true };
      const search = await import("../web-search/runtime.js");
      const fetch = await import("../web-fetch/runtime.js");
      vi.mocked(search.listWebSearchProvidersAsync).mockResolvedValue(
        scoped
          ? ([provider] as never)
          : [
              { id: "brave", envVars: ["BRAVE_API_KEY"] } as never,
              { id: "gemini", envVars: ["GEMINI_API_KEY"] } as never,
            ],
      );
      vi.mocked(fetch.listWebFetchProviders).mockReturnValueOnce(
        scoped ? [] : [{ id: "firecrawl", envVars: ["FIRECRAWL_API_KEY"] } as never],
      );
      if (!scoped) {
        mocks.isWebSearchProviderConfigured.mockReturnValueOnce(false).mockReturnValueOnce(true);
        mocks.isWebFetchProviderConfigured.mockReturnValueOnce(true);
      }
      await runCapability("web", "providers", ...(scoped ? ["--agent", "beta"] : []), "--json");
      if (scoped) {
        expect(firstJsonOutput()).toMatchObject({ search: [{ id: "openai" }], fetch: [] });
        expect(mocks.isWebSearchProviderConfigured).toHaveBeenCalledWith({
          provider,
          config: mocks.loadConfig(),
          agentDir: "/tmp/agent-beta",
          authStore: { version: 1, profiles: {} },
        });
      } else {
        expect(firstJsonOutput()).toMatchObject({
          search: [
            { id: "brave", configured: false, selected: false },
            { id: "gemini", configured: true, selected: true },
          ],
          fetch: [{ id: "firecrawl", configured: true, selected: true }],
        });
      }
    },
  );

  it.each(
    ["search", "direct fetch", "pinned fetch"].flatMap((route) =>
      ["success", "failure", "throw"].map((outcome) => ({ route, outcome })),
    ),
  )("discards late web $route $outcome after interruption", async ({ route, outcome }) => {
    const entered = createDeferredCore<AbortSignal | undefined>();
    const release = createDeferredCore();
    const result = outcome === "failure" ? { ok: false, error: "late failure" } : { text: "late" };
    const finish = async (signal?: AbortSignal) => {
      entered.resolve(signal);
      await release.promise;
      if (outcome === "throw") {
        throw new Error("late failure");
      }
      return result;
    };
    if (route === "search") {
      const { runWebSearch } = await import("../web-search/runtime.js");
      vi.mocked(runWebSearch).mockImplementationOnce(async ({ signal }) => ({
        provider: "fixture",
        result: await finish(signal),
      }));
    } else if (route === "direct fetch") {
      const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
      vi.mocked(createWebFetchTool).mockReturnValueOnce({
        execute: async (_id: string, _args: unknown, signal?: AbortSignal) => ({
          content: [],
          details: await finish(signal),
        }),
      } as never);
    } else {
      const { resolveWebFetchDefinition } = await import("../web-fetch/runtime.js");
      vi.mocked(resolveWebFetchDefinition).mockReturnValueOnce({
        provider: { id: "fixture" },
        definition: {
          execute: (_args: unknown, context?: { signal?: AbortSignal }) => finish(context?.signal),
        },
      } as never);
    }
    const scope = new AsyncWorkScope();
    const pending = scope.run(() =>
      runCapability(
        "web",
        route === "search" ? "search" : "fetch",
        route === "search" ? "--query" : "--url",
        "https://example.com",
        ...(route === "pinned fetch" ? ["--provider", "fixture"] : []),
        "--json",
      ),
    );
    const signal = await entered.promise;
    scope.beginClose();
    release.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
    expect(signal?.aborted).toBe(true);
  });

  it("reports structured web search failures and exits nonzero", async () => {
    const provider = "kitchen-sink-search";
    const message = "Kitchen Sink rate limit.";
    const runtime = await import("../web-search/runtime.js");
    vi.mocked(runtime.runWebSearch).mockResolvedValueOnce({
      provider,
      result: {
        ok: false,
        statusCode: 429,
        error: { code: "rate_limited", message },
        results: [],
      },
    });
    await expect(
      runCap("capability", "web", "search", "--query", "rate limit", "--json"),
    ).rejects.toThrow("exit 1");
    expect(firstJsonOutput()).toEqual(
      expect.objectContaining({
        ok: false,
        capability: "web.search",
        provider,
        error: message,
      }),
    );
  });

  it.each([
    { format: undefined, provider: undefined },
    { format: "text", provider: "firecrawl" },
  ])("fetches through the default tool with $format output", async ({ format, provider }) => {
    const config = { tools: { web: { fetch: { maxChars: 1200 } } } };
    const resolvedConfig = { ...config, resolved: true };
    mocks.loadConfig.mockReturnValue(config);
    mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
      resolvedConfig,
      effectiveConfig: resolvedConfig,
      diagnostics: [],
    });
    const result = {
      title: "Example Domain",
      text: "Example content",
      externalContent: { untrusted: true, source: "web_fetch", wrapped: true, provider },
    };
    const execute = vi.fn(async () => ({ content: [], details: result }));
    const { createWebFetchTool } = await import("../agents/tools/web-fetch.js");
    vi.mocked(createWebFetchTool).mockReturnValueOnce({ execute } as never);

    await runCap(
      "infer",
      "web",
      "fetch",
      "--url",
      "https://example.com",
      ...(format ? ["--format", format] : []),
      "--json",
    );

    expect(createWebFetchTool).toHaveBeenCalledWith({ config: resolvedConfig });
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "infer-web-fetch",
      { url: "https://example.com", extractMode: format },
      undefined,
    );
    expect(firstJsonOutput()).toEqual({
      ok: true,
      capability: "web.fetch",
      transport: "local",
      provider: provider ?? "direct",
      attempts: [],
      outputs: [{ result }],
    });
  });

  it.each([undefined, "firecrawl"])(
    "rejects disabled web fetch with provider %s",
    async (provider) => {
      mocks.loadConfig.mockReturnValue({ tools: { web: { fetch: { enabled: false } } } });

      await expect(
        runCap(
          "infer",
          "web",
          "fetch",
          "--url",
          "https://example.com",
          ...(provider ? ["--provider", provider] : []),
          "--json",
        ),
      ).rejects.toThrow("exit 1");

      expect(runtimeErrorMessages().join("\n")).toContain("tools.web.fetch.enabled");
      expect(mocks.runtime.writeJson).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      action: "search",
      config: { tools: { web: { search: { provider: "exa", enabled: true } } } },
      args: ["--query", "ping", "--limit", "3"],
    },
    {
      action: "fetch",
      config: { tools: { web: { fetch: { enabled: true } } } },
      args: ["--url", "https://example.com", "--format", "text"],
    },
  ])(
    "resolves selected web $action provider SecretRefs before execution",
    async ({ action, config, args }) => {
      const resolvedConfig = { ...config, resolved: true };
      mocks.loadConfig.mockReturnValue(config);
      mocks.resolveCommandConfigWithSecrets.mockResolvedValueOnce({
        resolvedConfig,
        effectiveConfig: resolvedConfig,
        diagnostics: [],
      });
      const search = await import("../web-search/runtime.js");
      const fetch = await import("../web-fetch/runtime.js");
      const execute = vi.fn(async () => ({ content: "ok" }));
      if (action === "search") {
        vi.mocked(search.runWebSearch).mockResolvedValueOnce({
          provider: "firecrawl",
          result: { results: [] },
        });
      } else {
        vi.mocked(fetch.resolveWebFetchDefinition).mockReturnValueOnce({
          provider: { id: "firecrawl" },
          definition: { execute },
        } as never);
      }
      await runCap("infer", "web", action, ...args, "--provider", "firecrawl", "--json");
      const targets =
        action === "search"
          ? mocks.getCapabilityWebSearchCommandSecretTargets
          : mocks.getCapabilityWebFetchCommandSecretTargets;
      expect(targets).toHaveBeenCalledWith(config, { providerId: "firecrawl" });
      const resolution = mocks.resolveCommandConfigWithSecrets.mock.calls.at(-1)?.[0];
      expect(resolution).toMatchObject({
        commandName: `infer web ${action}`,
        targetIds: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
        forcedActivePaths: new Set(["plugins.entries.firecrawl.config.webSearch.apiKey"]),
      });
      expect(resolution).not.toHaveProperty("allowedPaths");
      if (action === "search") {
        expect(search.runWebSearch).toHaveBeenCalledWith({
          config: resolvedConfig,
          providerId: "firecrawl",
          signal: undefined,
          args: { query: "ping", count: 3, limit: 3 },
        });
      } else {
        expect(fetch.resolveWebFetchDefinition).toHaveBeenCalledWith({
          config: resolvedConfig,
          providerId: "firecrawl",
        });
        expect(execute).toHaveBeenCalledExactlyOnceWith(
          { url: "https://example.com", extractMode: "text" },
          { signal: undefined },
        );
      }
    },
  );
}
