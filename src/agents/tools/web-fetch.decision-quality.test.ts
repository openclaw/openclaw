import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DecisionOutcome } from "../../decisions/types.js";
import { wrapWebContent } from "../../security/external-content.js";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  evaluate: vi.fn(),
  resolveFallback: vi.fn(),
}));
// mock-isolation: a deterministic HTTP response exercises the real fetch result path without network access.
vi.mock("./web-guarded-fetch.js", () => ({ fetchWithWebToolsNetworkGuard: mocks.fetch }));
// mock-isolation: force Decision outcomes while keeping provider lifecycle and credentials out of this tool test.
vi.mock("../../decisions/runtime.js", () => ({ evaluateDecisionInRegistry: mocks.evaluate }));
// mock-isolation: the mocked Decision runtime needs no Gateway registry.
vi.mock("../../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRegistryForContext: () => null,
}));
// mock-isolation: exercise provider fallback through the real web_fetch normalization path.
vi.mock("../../web-fetch/runtime.js", () => ({
  resolveWebFetchDefinition: mocks.resolveFallback,
}));

import { assessWebFetchQuality } from "./web-fetch-decision-quality.js";
import { createWebFetchTool } from "./web-fetch.js";

const page = "Specialized catalyst kinetics and reactor data that a researcher can cite.";

function config(mode?: "shadow" | "apply", consent = true): OpenClawConfig {
  return {
    agents: {
      defaults: {
        decisionModel: "fixture/model",
        experimental: { decisionAssistance: consent },
      },
    },
    tools: { web: { fetch: { cacheTtlMinutes: 0, decisionQuality: mode } } },
  };
}

function answer(probabilityUnusable: number): DecisionOutcome {
  return {
    status: "ok",
    provenance: { providerId: "fixture", rubricVersion: "1", runtimeGeneration: "test" },
    result: {
      model: "model",
      answers: { unusable_page: { type: "boolean", probabilityTrue: probabilityUnusable } },
    },
  };
}

async function execute(current: OpenClawConfig, agentId = "main", maxChars?: number) {
  const tool = createWebFetchTool({ config: current, agentId });
  if (!tool?.outputSchema) {
    throw new Error("expected web_fetch output schema");
  }
  const result = await tool.execute("quality-test", {
    url: "https://example.com/quality",
    ...(maxChars === undefined ? {} : { maxChars }),
  });
  expect(Value.Check(tool.outputSchema, result.details)).toBe(true);
  return result.details as Record<string, unknown>;
}

beforeEach(() => {
  clearRuntimeConfigSnapshot();
  mocks.fetch.mockReset().mockImplementation(async () => ({
    response: new Response(page, { status: 200, headers: { "content-type": "text/plain" } }),
    finalUrl: "https://example.com/quality",
    release: async () => {},
  }));
  mocks.evaluate.mockReset().mockResolvedValue(answer(0.995));
  mocks.resolveFallback.mockReset().mockReturnValue(null);
});

afterEach(() => {
  clearRuntimeConfigSnapshot();
});

describe("web_fetch Decision page quality", () => {
  it("does not invoke the model without the web mode, consent, or a trusted agent", async () => {
    for (const [current, agentId] of [
      [config(), "main"],
      [config("apply", false), "main"],
      [config("apply"), ""],
    ] as const) {
      const details = await execute(current, agentId);
      expect(details.text).toContain(page);
      expect(details).not.toHaveProperty("quality");
    }
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });

  it("evaluates in shadow mode without changing the fetched content", async () => {
    const details = await execute(config("shadow"));
    expect(details.text).toContain(page);
    expect(details.quality).toEqual({
      mode: "shadow",
      status: "evaluated",
      probabilityUnusable: 0.995,
      suppressed: false,
    });
    const [batch, options] = mocks.evaluate.mock.calls[0]!;
    expect(batch.state).toMatchObject({ extractedText: expect.stringContaining(page) });
    expect(Object.keys(batch.state)).not.toContain("url");
    expect(Object.keys(batch.state)).not.toContain("headers");
    expect(batch.state.extractedText.length).toBeLessThanOrEqual(6_000);
    expect(batch.questions.unusable_page.type).toBe("boolean");
    expect(options).toMatchObject({ agentId: "main", purpose: "web-fetch.page-quality" });
  });

  it("assesses normalized provider-fallback content as well as direct fetches", async () => {
    const providerExecute = vi.fn(async () => ({ text: "Access denied. Sign in to continue." }));
    mocks.resolveFallback.mockReturnValue({
      provider: { id: "fixture-fetch" },
      definition: { execute: providerExecute },
    });
    mocks.fetch.mockImplementationOnce(async () => ({
      response: new Response("upstream unavailable", { status: 503 }),
      finalUrl: "https://example.com/quality",
      release: async () => {},
    }));
    const details = await execute(config("apply"));
    expect(providerExecute).toHaveBeenCalledOnce();
    expect(details.externalContent).toMatchObject({ provider: "fixture-fetch" });
    expect(details.quality).toMatchObject({ status: "evaluated", suppressed: true });
    expect(details.text).not.toContain("Access denied");
  });

  it("withholds only strong unusable results in apply mode; uncertain content remains", async () => {
    const current = config("apply");
    mocks.evaluate.mockResolvedValueOnce(answer(0.899)).mockResolvedValueOnce(answer(0.9));
    const retained = await execute(current);
    expect(retained.text).toContain(page);
    expect(retained.quality).toMatchObject({ suppressed: false });
    const withheld = await execute(current);
    expect(withheld.text).not.toContain(page);
    expect(withheld.text).toContain("withheld");
    expect(withheld.length).toBe((withheld.text as string).length);
    expect(withheld.quality).toMatchObject({ suppressed: true });
    const bounded = await assessWebFetchQuality({
      config: current,
      agentId: "main",
      payload: { text: page, length: 100 },
    });
    expect((bounded.text as string).length).toBeLessThanOrEqual(100);
    expect(bounded.quality).toMatchObject({ suppressed: true });
  });

  it.each([200, 300])(
    "preserves the short-page withholding notice within maxChars %i",
    async (maxChars) => {
      mocks.fetch.mockImplementationOnce(async () => ({
        response: new Response("Sign in.", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
        finalUrl: "https://example.com/quality",
        release: async () => {},
      }));
      const details = await execute(config("apply"), "main", maxChars);
      expect(details.truncated).toBe(false);
      expect(details.quality).toMatchObject({ probabilityUnusable: 0.995, suppressed: true });
      expect(details.text).toContain("Likely unusable; withheld.");
      expect(details.text).toContain("Re-fetch with decisionQuality unset.");
      expect(details.text).toContain("<<<EXTERNAL_UNTRUSTED_CONTENT");
      expect(details.text).toContain("<<<END_EXTERNAL_UNTRUSTED_CONTENT");
      expect((details.text as string).length).toBeLessThanOrEqual(maxChars);
      expect(details.length).toBe((details.text as string).length);
    },
  );

  it.each(["title", "warning"] as const)(
    "keeps a complete withholding reason within the total budget when %s is retained",
    async (field) => {
      mocks.fetch.mockRejectedValueOnce(new Error("direct fetch unavailable"));
      mocks.resolveFallback.mockReturnValue({
        provider: { id: "fixture-fetch" },
        definition: { execute: async () => ({ text: "Sign in.", [field]: "Login" }) },
      });
      const details = await execute(config("apply"), "main", 300);
      expect(details.truncated).toBe(false);
      expect(details.quality).toMatchObject({ probabilityUnusable: 0.995, suppressed: true });
      expect(details[field]).toContain("Login");
      expect(details.text).toContain("Likely unusable; withheld.");
      expect(details.text).toContain("Re-fetch with decisionQuality unset.");
      expect(details.text).not.toContain("Sign in.");
      expect(
        (details.text as string).length +
          (typeof details.title === "string" ? details.title.length : 0) +
          (typeof details.warning === "string" ? details.warning.length : 0),
      ).toBeLessThanOrEqual(300);
    },
  );

  it("returns the original page when the provider is unavailable", async () => {
    mocks.evaluate.mockResolvedValue({ status: "unavailable", reason: "deadline" });
    const details = await execute(config("apply"));
    expect(details.text).toContain(page);
    expect(details.quality).toEqual({ mode: "apply", status: "unavailable", suppressed: false });
  });

  it("does not withhold a page whose visible excerpt was truncated", async () => {
    const result = await assessWebFetchQuality({
      config: config("apply"),
      agentId: "main",
      payload: { text: page, length: page.length, truncated: true },
    });
    expect(result.text).toBe(page);
    expect(result.quality).toMatchObject({ probabilityUnusable: 0.995, suppressed: false });
  });

  it("does not withhold an untruncated page when the model only saw its leading excerpt", async () => {
    const longPage = `${"Navigation, sign in, and advertising. ".repeat(190)}${page}`;
    const result = await assessWebFetchQuality({
      config: config("apply"),
      agentId: "main",
      payload: { text: longPage, length: longPage.length, truncated: false },
    });
    expect(mocks.evaluate.mock.calls[0]![0].state.excerptTruncated).toBe(true);
    expect(result.text).toBe(longPage);
    expect(result.quality).toMatchObject({ probabilityUnusable: 0.995, suppressed: false });
  });

  it("does not dispatch page content after runtime consent is replaced during fetch", async () => {
    const original = config("apply");
    setRuntimeConfigSnapshot(original, original);
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    mocks.fetch.mockImplementationOnce(async () => {
      started.resolve();
      await release.promise;
      return {
        response: new Response(page, { status: 200, headers: { "content-type": "text/plain" } }),
        finalUrl: "https://example.com/quality",
        release: async () => {},
      };
    });
    const pending = execute(original);
    try {
      await started.promise;
      const revoked = config();
      setRuntimeConfigSnapshot(revoked, revoked);
      release.resolve();
      const details = await pending;
      expect(details.text).toContain(page);
      expect(details).not.toHaveProperty("quality");
      expect(mocks.evaluate).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
    }
  });

  it("does not send a private spill locator to the Decision provider", async () => {
    const wrapped = wrapWebContent(page, "web_fetch");
    const result = await assessWebFetchQuality({
      config: config("shadow"),
      agentId: "main",
      payload: {
        text: `${wrapped}\n\n[Showing truncated web_fetch content. Full output: /tmp/private-spill.]`,
        length: wrapped.length + 84,
        spill: { path: "/tmp/private-spill", chars: 9_000 },
        truncated: true,
      },
    });
    expect(result.quality).toMatchObject({ status: "evaluated", suppressed: false });
    expect(mocks.evaluate.mock.calls[0]![0].state.extractedText).toBe(wrapped);
  });

  it("fails open on a Decision runtime error, but propagates caller cancellation", async () => {
    mocks.evaluate.mockRejectedValueOnce(new Error("provider failure"));
    const retained = await execute(config("apply"));
    expect(retained.text).toContain(page);
    expect(retained.quality).toMatchObject({ status: "unavailable", suppressed: false });

    const controller = new AbortController();
    mocks.evaluate.mockImplementationOnce(async () => {
      controller.abort();
      return answer(1);
    });
    const tool = createWebFetchTool({ config: config("apply"), agentId: "main" });
    await expect(
      tool!.execute(
        "cancelled",
        { url: "https://example.com/quality-cancelled" },
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it("keeps the unfiltered fetch in cache across shadow and apply modes", async () => {
    const current = config("shadow");
    current.tools!.web!.fetch!.cacheTtlMinutes = 15;
    const tool = createWebFetchTool({ config: current, agentId: "main" });
    if (!tool) {
      throw new Error("expected web_fetch");
    }
    const first = (await tool.execute("shadow", { url: "https://example.com/quality-cache" }))
      .details as Record<string, unknown>;
    expect(first.text).toContain(page);
    current.tools!.web!.fetch!.decisionQuality = "apply";
    const second = (await tool.execute("apply", { url: "https://example.com/quality-cache" }))
      .details as Record<string, unknown>;
    expect(second.cached).toBe(true);
    expect(second.text).not.toContain(page);
    expect(second.quality).toMatchObject({ suppressed: true });
    expect(mocks.fetch).toHaveBeenCalledOnce();
  });

  it("does not apply a result after the web mode or selected model changes", async () => {
    for (const change of [
      (current: OpenClawConfig) => {
        current.tools!.web!.fetch!.decisionQuality = "shadow";
      },
      (current: OpenClawConfig) => {
        current.agents!.defaults!.decisionModel = "fixture/new-model";
      },
    ]) {
      const current = config("apply");
      mocks.evaluate.mockImplementationOnce(async () => {
        change(current);
        return answer(1);
      });
      const details = await execute(current);
      expect(details.text).toContain(page);
      expect(details).not.toHaveProperty("quality");
    }
  });
});
