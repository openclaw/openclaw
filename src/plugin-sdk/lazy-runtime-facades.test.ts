import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../test-utils/prepare-compiled-subprocesses.js";
import { createProviderUsageFetch } from "../test-utils/provider-usage-fetch.js";

const fetchFn = createProviderUsageFetch(() => {
  throw new Error("SDK forwarding must use the selected execution owner");
});
const usageArgs = ["sdk-usage-token", 137, fetchFn] as const;
const codexArgs = [usageArgs[0], "sdk-account", usageArgs[1], fetchFn] as const;
const geminiArgs = [...usageArgs, "openai"] as const;
const minimaxArgs = [...usageArgs, { baseUrl: "https://usage.example/anthropic" }] as const;
const preparationParams = {
  cfg: { agents: { defaults: { model: "synthetic/model" } } },
  agentId: "sdk-agent",
  modelRef: "synthetic/model@profile",
} satisfies Parameters<
  typeof import("./simple-completion-runtime.js").prepareSimpleCompletionModelForAgent
>[0];

function usageCase(
  name: string,
  provider: string,
  args: readonly unknown[],
  invoke: (sdk: typeof import("./provider-usage.js")) => Promise<unknown>,
) {
  return {
    name,
    ownerExport: name,
    owner: `../infra/provider-usage.fetch.${provider}.js`,
    args,
    load: async () => {
      const sdk = await import("./provider-usage.js");
      return () => invoke(sdk);
    },
  };
}
const cases = [
  usageCase("fetchClaudeUsage", "claude", usageArgs, (sdk) => sdk.fetchClaudeUsage(...usageArgs)),
  usageCase("fetchCodexUsage", "codex", codexArgs, (sdk) => sdk.fetchCodexUsage(...codexArgs)),
  usageCase("fetchDeepSeekUsage", "deepseek", usageArgs, (sdk) =>
    sdk.fetchDeepSeekUsage(...usageArgs),
  ),
  usageCase("fetchGeminiUsage", "gemini", geminiArgs, (sdk) => sdk.fetchGeminiUsage(...geminiArgs)),
  usageCase("fetchMinimaxUsage", "minimax", minimaxArgs, (sdk) =>
    sdk.fetchMinimaxUsage(...minimaxArgs),
  ),
  usageCase("fetchZaiUsage", "zai", usageArgs, (sdk) => sdk.fetchZaiUsage(...usageArgs)),
  {
    name: "prepareSimpleCompletionModelForAgent",
    ownerExport: "acquireSimpleCompletionModelForAgent",
    owner: "../agents/simple-completion-runtime.js",
    args: [preparationParams],
    load: async () => {
      const sdk = await import("./simple-completion-runtime.js");
      return () => sdk.prepareSimpleCompletionModelForAgent(preparationParams);
    },
  },
];

beforeEach(() => {
  vi.resetModules();
  fetchFn.mockClear();
});

afterEach(() => {
  for (const testCase of cases) {
    vi.doUnmock(testCase.owner);
  }
  vi.resetModules();
});

describe("lazy SDK execution facades", () => {
  it.each(cases)(
    "defers $name to its execution owner and preserves arguments and outcomes",
    async (testCase) => {
      const loaded: string[] = [];
      const resolvedError = { error: "Owner unavailable" };
      const failure = new Error("Owner request failed");
      const execute = vi.fn<(...args: unknown[]) => Promise<unknown>>();
      execute.mockResolvedValueOnce(resolvedError).mockRejectedValueOnce(failure);
      for (const entry of cases) {
        vi.doMock(entry.owner, () => {
          loaded.push(entry.owner);
          return { [entry.ownerExport ?? entry.name]: execute };
        });
      }

      const invoke = await testCase.load();
      expect(loaded).toEqual([]);
      expect(execute).not.toHaveBeenCalled();

      await expect(invoke()).resolves.toBe(resolvedError);
      await expect(invoke()).rejects.toBe(failure);

      expect(loaded).toEqual([testCase.owner]);
      expect(execute).toHaveBeenCalledTimes(2);
      for (const call of execute.mock.calls) {
        expect(call).toHaveLength(testCase.args.length);
        for (const [index, argument] of testCase.args.entries()) {
          expect(call[index]).toBe(argument);
        }
      }
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );
});
