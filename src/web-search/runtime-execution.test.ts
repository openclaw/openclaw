import { describe, expect, it, vi } from "vitest";
import type { WebSearchProviderToolDefinition } from "../plugins/web-provider-types.js";
import { createWebSearchTestProvider } from "../test-utils/web-provider-runtime.test-helpers.js";
import { executeWebSearchCandidates } from "./runtime-execution.js";

function candidate(id: string, execute: WebSearchProviderToolDefinition["execute"]) {
  return createWebSearchTestProvider({
    id,
    pluginId: "fixture-search",
    credentialPath: `plugins.entries.fixture-search.config.${id}`,
    createTool: () => ({ description: id, parameters: {}, execute }),
  });
}

describe("executeWebSearchCandidates", () => {
  it("tries every fallback and retains the first error with its cause", async () => {
    const cause = new Error("first transport failure");
    const firstError = new Error("first provider failed", { cause });
    const attempts: string[] = [];
    const result = executeWebSearchCandidates({
      candidates: [
        candidate("first", async () => {
          attempts.push("first");
          throw firstError;
        }),
        candidate("second", async () => {
          attempts.push("second");
          throw new Error("second provider failed");
        }),
      ],
      args: { query: "synthetic query" },
      allowFallback: true,
    });
    await expect(result).rejects.toBe(firstError);
    expect(firstError.cause).toBe(cause);
    expect(attempts).toEqual(["first", "second"]);
  });

  it.each(["first rejection", null, undefined])(
    "retains the first non-Error rejection: %s",
    async (firstRejection) => {
      await expect(
        executeWebSearchCandidates({
          candidates: [
            candidate(
              "first",
              vi.fn<WebSearchProviderToolDefinition["execute"]>().mockRejectedValue(firstRejection),
            ),
            candidate("second", async () => {
              throw new Error("second provider failed");
            }),
          ],
          args: {},
          allowFallback: true,
        }),
      ).rejects.toThrow(String(firstRejection));
    },
  );

  it.each([true, false])(
    "retains chronology across structured and thrown errors (structured first: %s)",
    async (structuredFirst) => {
      const thrown = new Error("ordinary provider failure");
      const missingKey = async () => ({ error: "missing_fixture_api_key" });
      const fail = async () => {
        throw thrown;
      };
      const result = executeWebSearchCandidates({
        candidates: [
          candidate("first", structuredFirst ? missingKey : fail),
          candidate("second", structuredFirst ? fail : missingKey),
        ],
        args: {},
        allowFallback: true,
      });
      if (structuredFirst) {
        await expect(result).rejects.toThrow(
          'web_search provider "first" returned missing_fixture_api_key',
        );
      } else {
        await expect(result).rejects.toBe(thrown);
      }
    },
  );

  it("does not treat a thrown undefined as an unavailable factory", async () => {
    const unavailable = createWebSearchTestProvider({
      id: "unavailable",
      pluginId: "fixture-search",
      credentialPath: "plugins.entries.fixture-search.config.unavailable",
      createTool: () => null,
    });
    await expect(
      executeWebSearchCandidates({
        candidates: [
          candidate(
            "first",
            vi.fn<WebSearchProviderToolDefinition["execute"]>().mockRejectedValue(undefined),
          ),
          unavailable,
        ],
        args: {},
        allowFallback: true,
      }),
    ).rejects.toThrow("undefined");
  });

  it("gives cancellation precedence over a saved failure and later cleanup error", async () => {
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    await expect(
      executeWebSearchCandidates({
        candidates: [
          candidate("first", async () => {
            throw new Error("first provider failure");
          }),
          candidate("second", async () => {
            controller.abort(reason);
            throw new Error("second provider cleanup failure");
          }),
        ],
        args: {},
        signal: controller.signal,
        allowFallback: true,
      }),
    ).rejects.toBe(reason);
  });

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
      executeWebSearchCandidates({
        candidates: [
          createWebSearchTestProvider({
            id: "unused",
            pluginId: "fixture-search",
            credentialPath: "plugins.entries.fixture-search.config.unused",
            createTool,
          }),
        ],
        args: {},
        signal: controller.signal,
        allowFallback: true,
      }),
    ).rejects.toBe(reason);
    expect(createTool).not.toHaveBeenCalled();
  });
});
