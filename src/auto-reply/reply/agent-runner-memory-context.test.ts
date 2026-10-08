import { expect, it } from "vitest";
import {
  getContextWindowCaches,
  providerContextTokenCacheKey,
} from "../../agents/context-cache.js";
import { resolveFollowupContextTokens } from "./agent-runner-memory-context.js";
import { createTestFollowupRun } from "./agent-runner.test-fixtures.js";

it.each([
  {
    name: "selected",
    selected: "small",
    declaresOptions: true,
    contextTokens: undefined,
    expected: 200_000,
  },
  {
    name: "default",
    selected: undefined,
    declaresOptions: true,
    contextTokens: undefined,
    expected: 200_000,
  },
  {
    name: "scalar",
    selected: undefined,
    declaresOptions: false,
    contextTokens: undefined,
    expected: 1_000_000,
  },
  {
    name: "reported prompt",
    selected: undefined,
    declaresOptions: false,
    contextTokens: 64_000,
    expected: 64_000,
  },
])(
  "uses the $name catalog window for fixed-window memory budgets",
  async ({ selected, declaresOptions, contextTokens, expected }) => {
    const followupRun = createTestFollowupRun({
      provider: "anthropic",
      model: "claude-opus-5",
      thinkingCatalog: [
        {
          provider: "anthropic",
          id: "claude-opus-5",
          contextWindow: 1_000_000,
          contextTokens,
          ...(declaresOptions
            ? {
                contextWindows: [{ id: "small", label: "Small", contextWindow: 200_000 }],
                contextWindowDefault: "small",
              }
            : {}),
        },
      ],
    });
    expect(
      await resolveFollowupContextTokens(
        {
          cfg: {},
          followupRun,
          defaultModel: "anthropic/claude-opus-5",
          sessionEntry: { sessionId: "memory-context", updatedAt: 0, contextWindow: selected },
        },
        "openclaw",
      ),
    ).toBe(expected);
  },
);

it.each([
  {
    name: "unretained B",
    profileId: "fixture-provider:account-b",
    prior: false,
    source: "resolved-v1" as const,
    expected: 128_000,
  },
  {
    name: "retained A on B",
    profileId: "fixture-provider:account-b",
    prior: true,
    source: "resolved-v1" as const,
    expected: 128_000,
  },
  {
    name: "runtime matching A",
    profileId: "fixture-provider:account-a",
    prior: true,
    source: "runtime" as const,
    expected: 888_000,
  },
])(
  "qualifies the $name maintenance budget against its selected account",
  async ({ profileId, prior, source, expected }) => {
    const caches = getContextWindowCaches();
    const key = providerContextTokenCacheKey("fixture-provider", "memory-model");
    const previous = caches.discoveredTokenCache.get(key);
    caches.discoveredTokenCache.set(key, 1_000_000);
    try {
      const followupRun = createTestFollowupRun({
        provider: "fixture-provider",
        model: "memory-model",
        authProfileId: profileId,
        thinkingCatalog: [
          {
            provider: "fixture-provider",
            id: "memory-model",
            contextWindow: 128_000,
            contextWindowSource: "synthetic",
          },
        ],
      });
      expect(
        await resolveFollowupContextTokens(
          {
            cfg: {},
            followupRun,
            defaultModel: "memory-model",
            sessionEntry: prior
              ? {
                  sessionId: "memory-account",
                  updatedAt: 0,
                  modelProvider: "fixture-provider",
                  model: "memory-model",
                  agentHarnessId: "openclaw",
                  authProfileOverride: "fixture-provider:account-a",
                  contextTokens: 888_000,
                  contextTokensSource: source,
                }
              : undefined,
          },
          "openclaw",
        ),
      ).toBe(expected);
    } finally {
      if (previous === undefined) {
        caches.discoveredTokenCache.delete(key);
      } else {
        caches.discoveredTokenCache.set(key, previous);
      }
    }
  },
);
