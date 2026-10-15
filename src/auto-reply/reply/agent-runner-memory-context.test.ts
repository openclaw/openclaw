import { expect, it } from "vitest";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
} from "../../agents/context-cache.js";
import { resolveFollowupContextTokens } from "./agent-runner-memory-runtime.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

it.each([
  { name: "accepted prompt", selected: undefined, cap: undefined, expected: 872_000 },
  { name: "selected window", selected: "small", cap: undefined, expected: 200_000 },
  { name: "authored cap", selected: undefined, cap: 64_000, expected: 64_000 },
])("uses the $name budget for maintenance", ({ selected, cap, expected }) => {
  const provider = "fixture-maintenance";
  const model = "maintenance-model";
  const followupRun = createTestFollowupRun({
    provider,
    model,
    thinkingCatalog: [
      {
        provider,
        id: model,
        contextWindow: 128_000,
        contextWindowSource: "synthetic",
        contextTokens: 872_000,
        contextWindows: [{ id: "small", label: "Small", contextWindow: 200_000 }],
      },
    ],
  });
  expect(
    resolveFollowupContextTokens(
      {
        cfg: cap
          ? {
              models: {
                providers: {
                  [provider]: {
                    baseUrl: "https://fixture.example.test/v1",
                    models: [
                      {
                        id: model,
                        name: model,
                        contextTokens: cap,
                        reasoning: false,
                        input: ["text"],
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                        maxTokens: 16384,
                      },
                    ],
                  },
                },
              },
            }
          : {},
        followupRun,
        defaultModel: model,
        sessionEntry: {
          sessionId: followupRun.run.sessionId,
          updatedAt: 0,
          contextWindow: selected,
        },
      },
      "openclaw",
    ),
  ).toBe(expected);
});

it("ignores a foreign runtime catalog and unqualified shared cache", () => {
  const provider = "fixture-maintenance-runtime";
  const model = "maintenance-model";
  const caches = getContextWindowCaches();
  const key = providerContextTokenCacheKey(provider, model);
  const previous = caches.discoveredTokenCache.get(key);
  caches.discoveredTokenCache.set(key, 1_000_000);
  try {
    const followupRun = createTestFollowupRun({
      provider,
      model,
      thinkingCatalog: [
        { provider, id: model, nativeRuntime: "codex", contextWindow: 1_000_000 },
        { provider, id: model, contextWindow: 200_000 },
      ],
    });
    expect(
      resolveFollowupContextTokens({ cfg: {}, followupRun, defaultModel: model }, "openclaw"),
    ).toBe(200_000);
  } finally {
    if (previous === undefined) {
      caches.discoveredTokenCache.delete(key);
    } else {
      caches.discoveredTokenCache.set(key, previous);
    }
  }
});

it("keeps the admitted synthetic estimate when prompt capacity is unknown", () => {
  const followupRun = createTestFollowupRun({
    provider: "fixture-unknown",
    model: "unknown-model",
    thinkingCatalog: [
      {
        provider: "fixture-unknown",
        id: "unknown-model",
        contextWindow: 128_000,
        contextWindowSource: "synthetic",
      },
    ],
  });
  expect(
    resolveFollowupContextTokens(
      { cfg: {}, followupRun, defaultModel: "unknown-model" },
      "openclaw",
    ),
  ).toBe(128_000);
});

it("ignores a selected window from a different session", () => {
  const followupRun = createTestFollowupRun({
    provider: "fixture-session",
    model: "session-model",
    thinkingCatalog: [
      {
        provider: "fixture-session",
        id: "session-model",
        contextTokens: 872_000,
        contextWindows: [{ id: "small", label: "Small", contextWindow: 200_000 }],
      },
    ],
  });
  expect(
    resolveFollowupContextTokens(
      {
        cfg: {},
        followupRun,
        defaultModel: "session-model",
        sessionEntry: { sessionId: "foreign-session", updatedAt: 0, contextWindow: "small" },
      },
      "openclaw",
    ),
  ).toBe(872_000);
});
