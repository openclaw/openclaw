/**
 * Tests for the credential pre-flight check added to sessions.patch when the
 * model selector filter is "authenticated" or "configured".
 *
 * When `gateway.controlUi.modelSelector.filter` is set, selecting a model
 * whose provider has no usable credentials should be rejected with a clear
 * error message.
 */
import { describe, expect, test, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";

// Mock the checkProviderAuth function used by the pre-flight check.
// Control which providers are "authenticated" via this set.
const authedProviders = new Set<string>();

vi.mock("../agents/model-selection.js", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    checkProviderAuth: (provider: string, _cfg: unknown) => authedProviders.has(provider),
  };
});

import { applySessionsPatchToStore } from "./sessions-patch.js";

const MAIN_SESSION_KEY = "agent:main:main";

type ApplySessionsPatchArgs = Parameters<typeof applySessionsPatchToStore>[0];

async function runPatch(params: {
  patch: ApplySessionsPatchArgs["patch"];
  store?: Record<string, SessionEntry>;
  cfg?: OpenClawConfig;
  storeKey?: string;
  loadGatewayModelCatalog?: ApplySessionsPatchArgs["loadGatewayModelCatalog"];
}) {
  return applySessionsPatchToStore({
    cfg: params.cfg ?? ({} as OpenClawConfig),
    store: params.store ?? {},
    storeKey: params.storeKey ?? MAIN_SESSION_KEY,
    patch: params.patch,
    loadGatewayModelCatalog:
      params.loadGatewayModelCatalog ??
      (async () => [
        { provider: "anthropic", id: "claude-opus-4-6", name: "Claude Opus 4.6" },
        { provider: "openai", id: "gpt-5.2", name: "GPT-5.2" },
        { provider: "google", id: "gemini-3-pro-preview", name: "Gemini 3 Pro" },
      ]),
  });
}

function expectPatchOk(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
): SessionEntry {
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error(result.error.message);
  }
  return result.entry;
}

function expectPatchError(
  result: Awaited<ReturnType<typeof applySessionsPatchToStore>>,
  substring: string,
): void {
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error(`Expected patch failure containing: ${substring}`);
  }
  expect(result.error.message).toContain(substring);
}

function cfgWithFilter(filter: "all" | "authenticated" | "configured"): OpenClawConfig {
  return {
    gateway: {
      controlUi: {
        modelSelector: { filter },
      },
    },
  } as OpenClawConfig;
}

describe("sessions.patch model selector pre-flight", () => {
  test('model selection succeeds when filter is "all" regardless of auth', async () => {
    authedProviders.clear(); // No providers authenticated

    const entry = expectPatchOk(
      await runPatch({
        cfg: cfgWithFilter("all"),
        patch: { key: MAIN_SESSION_KEY, model: "openai/gpt-5.2" },
      }),
    );

    expect(entry.providerOverride).toBe("openai");
    expect(entry.modelOverride).toBe("gpt-5.2");
  });

  test('model selection succeeds when filter is "authenticated" and provider has auth', async () => {
    authedProviders.clear();
    authedProviders.add("openai");

    const entry = expectPatchOk(
      await runPatch({
        cfg: cfgWithFilter("authenticated"),
        patch: { key: MAIN_SESSION_KEY, model: "openai/gpt-5.2" },
      }),
    );

    expect(entry.providerOverride).toBe("openai");
    expect(entry.modelOverride).toBe("gpt-5.2");
  });

  test('model selection rejected when filter is "authenticated" and provider has no auth', async () => {
    authedProviders.clear();
    // openai is NOT authenticated

    const result = await runPatch({
      cfg: cfgWithFilter("authenticated"),
      patch: { key: MAIN_SESSION_KEY, model: "openai/gpt-5.2" },
    });

    expectPatchError(result, "No valid credentials for provider");
  });

  test('model selection rejected when filter is "configured" and provider has no auth', async () => {
    authedProviders.clear();
    // google is NOT authenticated

    const result = await runPatch({
      cfg: cfgWithFilter("configured"),
      patch: { key: MAIN_SESSION_KEY, model: "google/gemini-3-pro-preview" },
    });

    expectPatchError(result, "No valid credentials for provider");
  });

  test('model selection succeeds when filter is "configured" and provider has auth', async () => {
    authedProviders.clear();
    authedProviders.add("openai");

    const entry = expectPatchOk(
      await runPatch({
        cfg: cfgWithFilter("configured"),
        patch: { key: MAIN_SESSION_KEY, model: "openai/gpt-5.2" },
      }),
    );

    expect(entry.providerOverride).toBe("openai");
    expect(entry.modelOverride).toBe("gpt-5.2");
  });

  test("pre-flight is skipped when config has no filter (defaults to all)", async () => {
    authedProviders.clear(); // No auth at all

    const entry = expectPatchOk(
      await runPatch({
        cfg: {} as OpenClawConfig,
        patch: { key: MAIN_SESSION_KEY, model: "openai/gpt-5.2" },
      }),
    );

    expect(entry.providerOverride).toBe("openai");
    expect(entry.modelOverride).toBe("gpt-5.2");
  });

  test("error message includes the provider name", async () => {
    authedProviders.clear();

    const result = await runPatch({
      cfg: cfgWithFilter("authenticated"),
      patch: { key: MAIN_SESSION_KEY, model: "google/gemini-3-pro-preview" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("google");
    }
  });
});
