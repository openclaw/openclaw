import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createModelGatewayFixture } from "./model-gateway.test-support.ts";
import { expandProvider } from "./model-providers.test-support.ts";
import {
  createReasoningUpstream,
  type ReasoningUpstream,
} from "./reasoning-upstream.test-support.js";

// Measured reasoning models (kimi-k3, minimax-m2.7) spend a small output cap on
// thinking and return no visible text. 300 reasoning tokens exceeds the 8-token cap
// Test access used to send, so a capped check reports a working provider as broken.
const REASONING_TOKENS = 300;
let upstream: ReasoningUpstream;
const model = (id: string) => ({
  id,
  name: id,
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 8192,
});
const fixture = createModelGatewayFixture({
  name: "Connection checks against a reasoning provider in each API family",
  instanceName: "model-connection-check",
  createUpstream() {
    upstream = createReasoningUpstream(REASONING_TOKENS);
    return upstream.server;
  },
  config: (base) => ({
    gateway: { controlUi: { enabled: true } },
    agents: { entries: { main: {} } },
    models: {
      providers: {
        "fixture-completions": {
          baseUrl: `${base}/v1`,
          api: "openai-completions",
          apiKey: "sk-synthetic-completions",
          models: [model("fixture-thinker")],
        },
        "fixture-messages": {
          baseUrl: base,
          api: "anthropic-messages",
          apiKey: "sk-synthetic-messages",
          models: [model("fixture-thinker")],
        },
        // Same endpoint and model, plus a header rewrite the provider rejects.
        "fixture-broken": {
          baseUrl: `${base}/v1`,
          api: "openai-completions",
          apiKey: "sk-synthetic-broken",
          headers: { "x-fixture-break": "1" },
          models: [model("fixture-thinker")],
        },
        "fixture-responses": {
          baseUrl: `${base}/v1`,
          api: "openai-responses",
          apiKey: "sk-synthetic-responses",
          models: [model("fixture-thinker")],
        },
      },
    },
  }),
});
const { suite, open } = fixture;

const options = {
  locale: "en-US",
  serviceWorkers: "block",
  viewport: { width: 1280, height: 900 },
} as const;

suite.define(() => {
  it("Test access passes reasoning models in every API family and fails a broken rewrite", async () => {
    await suite.withPage(options, async ({ page }) => {
      await page.goto(await open("settings/model-providers"));
      await waitForControlUiGatewayReady(page);
      for (const [id, label] of [
        ["fixture-completions", "Fixture Completions"],
        ["fixture-messages", "Fixture Messages"],
        ["fixture-responses", "Fixture Responses"],
      ] as const) {
        await expandProvider(page, id);
        const row = page.locator(`li.provider-row[data-provider-id="${id}"]`);
        const sent = upstream.requests.length;
        await row.getByRole("button", { name: `Test access: ${label}`, exact: true }).click();
        await row
          .locator(".model-providers__probe")
          .getByText(/Access verified|Invalid response|failed/)
          .first()
          .waitFor({ timeout: 30_000 });
        expect(await row.locator(".model-providers__probe").textContent()).toContain(
          "Access verified",
        );
        // The check sent no output cap of its own, so the model could finish thinking.
        expect(upstream.requests.slice(sent).every((request) => request.maxTokens !== 8)).toBe(
          true,
        );
      }
      // A broken request rewrite fails the check instead of passing a provider chat can't use.
      await expandProvider(page, "fixture-broken");
      const broken = page.locator('li.provider-row[data-provider-id="fixture-broken"]');
      await broken
        .getByRole("button", { name: "Test access: Fixture Broken", exact: true })
        .click();
      const result = broken.locator(".model-providers__probe");
      await result
        .getByText(/Access verified|Invalid response|failed/)
        .first()
        .waitFor({ timeout: 30_000 });
      expect(await result.textContent()).not.toContain("Access verified");
    });
  });
});
