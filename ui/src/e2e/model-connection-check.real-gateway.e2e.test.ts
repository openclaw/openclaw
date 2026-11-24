import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { expandProvider } from "./model-providers.test-support.ts";
import {
  createReasoningUpstream,
  type ReasoningUpstream,
} from "./reasoning-upstream.test-support.js";

// Measured reasoning models (kimi-k3, minimax-m2.7) spend a small output cap on
// thinking and return no visible text. 300 reasoning tokens exceeds the 8-token cap
// Test access used to send, so a capped check reports a working provider as broken.
const REASONING_TOKENS = 300;
let instance: OpenClawTestInstance;
let upstream: ReasoningUpstream;
const model = (id: string) => ({
  id,
  name: id,
  reasoning: true,
  contextWindow: 128000,
  maxTokens: 8192,
});
const suite = createControlUiE2eSuite({
  name: "Connection checks against a reasoning provider in each API family",
  startServerBeforeBrowser: true,
  async startServer() {
    upstream = createReasoningUpstream(REASONING_TOKENS);
    const listener = await reserveTestPortListener({
      offsets: [0],
      createListener: () => upstream.server,
    });
    const base = `http://127.0.0.1:${listener.claim.port}`;
    instance = await createOpenClawTestInstance({
      name: "model-connection-check",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        // Host provider keys would satisfy first-run setup and skip the check under test.
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
      },
      config: {
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
      },
    });
    const close = async () => {
      try {
        await instance.cleanup();
      } finally {
        listener.listener.closeAllConnections();
        await listener.releaseListener();
        await listener.claim.release();
      }
    };
    await instance.startGateway().catch(async (error: unknown) => {
      await close();
      throw error;
    });
    return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
  },
});

// Pairing links are single-use, so each page load gets its own handoff.
async function open(route: string) {
  const handoff = await instance.cli(["dashboard", "--json"]);
  expect(handoff.code, handoff.stderr).toBe(0);
  const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
  const url = new URL(route, browserUrl);
  url.hash = new URL(browserUrl).hash;
  return url.href;
}

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
