import { createServer } from "node:http";
import { buffer } from "node:stream/consumers";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { expandProvider } from "./model-providers.test-support.ts";
import { respondAsReasoningModel } from "./reasoning-upstream.test-support.js";

const STATUS_BY_KEY: Record<string, [number, string]> = {
  "sk-synthetic-revoked": [401, "Incorrect API key provided"],
  "sk-synthetic-noaccess": [403, "This key has no access to the requested model"],
  "sk-synthetic-servererror": [500, "Internal server error"],
};
let instance: OpenClawTestInstance;
const suite = createControlUiE2eSuite({
  name: "Saving an API key checks it against the provider",
  startServerBeforeBrowser: true,
  async startServer() {
    const upstream = await reserveTestPortListener({
      offsets: [0],
      createListener: () =>
        createServer((request, response) => {
          if (request.url === "/v1/models") {
            request.resume();
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: "hy4-preview" }, { id: "current" }] }));
            return;
          }
          void buffer(request).then((raw) => {
            const key = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
            const failure = STATUS_BY_KEY[key];
            if (failure) {
              response.writeHead(failure[0], { "content-type": "application/json" });
              response.end(JSON.stringify({ error: { message: failure[1], code: failure[0] } }));
              return;
            }
            const body = JSON.parse(raw.toString() || "{}");
            if (!respondAsReasoningModel(request.url ?? "", body, response, 20)) {
              response.writeHead(404).end();
            }
          });
        }),
    });
    const baseUrl = `http://127.0.0.1:${upstream.claim.port}/v1`;
    instance = await createOpenClawTestInstance({
      name: "model-key-save-check",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
      },
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { entries: { main: {} }, defaults: { model: "fixture/current" } },
        plugins: { allow: ["tencent"] },
        models: {
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "sk-synthetic-original",
              baseUrl,
              models: [{ id: "current", name: "Fixture model" }],
            },
            // Overriding baseUrl drops the bundled catalog, so list the model the check uses.
            "tencent-tokenhub": {
              baseUrl,
              api: "openai-completions",
              models: [{ id: "hy4-preview", name: "Hy4" }],
            },
          },
        },
      },
    });
    const close = async () => {
      try {
        await instance.cleanup();
      } finally {
        upstream.listener.closeAllConnections();
        await upstream.releaseListener();
        await upstream.claim.release();
      }
    };
    await instance.startGateway().catch(async (error: unknown) => {
      await close();
      throw error;
    });
    return { baseUrl: `http://127.0.0.1:${instance.port}/`, close };
  },
});

async function open(route: string) {
  const handoff = await instance.cli(["dashboard", "--json"]);
  expect(handoff.code, handoff.stderr).toBe(0);
  const { browserUrl }: { browserUrl: string } = JSON.parse(handoff.stdout);
  const url = new URL(route, browserUrl);
  url.hash = new URL(browserUrl).hash;
  return url.href;
}

const SETTLED = /API key saved|Added|verified|rejected|failed|no access|overloaded|error/i;

/** Saves through `save` and returns the message shown, with how long it took. */
async function saveAndRead(scope: Locator, save: () => Promise<void>) {
  const started = Date.now();
  await save();
  const message = scope.locator(".settings-message, [role='alert'], [role='status']").filter({
    hasText: SETTLED,
  });
  await message.first().waitFor({ timeout: 30_000 });
  // Let a check that follows the save finish before reading the final message.
  await expect.poll(async () => scope.getByText(/Checking/u).count(), { timeout: 30_000 }).toBe(0);
  return { text: (await scope.textContent()) ?? "", ms: Date.now() - started };
}

suite.define(() => {
  it("reports a rejected key where it was entered and keeps the field editable", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        const row = await expandProvider(page, "fixture");
        const enterKey = async (key: string) => {
          const button = row.getByRole("button", { name: "Replace API key: Fixture", exact: true });
          if ((await button.count()) > 0) {
            await button.click();
          }
          await row.getByLabel("API key", { exact: true }).fill(key);
        };
        const save = () => row.getByRole("button", { name: "Save", exact: true }).click();

        for (const [key, reason] of [
          ["sk-synthetic-revoked", /didn’t accept it\. Authentication failed\./u],
          ["sk-synthetic-noaccess", /didn’t accept it\. Authentication failed\./u],
          // A 5xx says nothing about the key, so it's reported as an unfinished check.
          ["sk-synthetic-servererror", /check didn’t finish\. The connection check failed\./u],
        ] as const) {
          // Measure Save through its result, after opening and filling the form.
          await enterKey(key);
          const { text, ms } = await saveAndRead(row, save);
          expect(text, key).not.toMatch(/API key saved\.(?! but)/u);
          expect(text, key).toMatch(reason);
          expect(ms, key).toBeLessThan(2_000);
          // A rejected key stays open to correct; an unfinished check closes the saved key's form.
          const fields = row.getByLabel("API key", { exact: true });
          if (key === "sk-synthetic-servererror") {
            expect(await fields.count(), key).toBe(0);
          } else {
            expect(await fields.isEditable(), key).toBe(true);
          }
        }

        await enterKey("sk-synthetic-good");
        const good = await saveAndRead(row, save);
        expect(good.text).toContain("API key saved and verified.");
        expect(await row.getByLabel("API key", { exact: true }).count()).toBe(0);

        // Adding a provider checks the key the same way, inside the add dialog.
        await page.getByRole("button", { name: "Add account", exact: true }).first().click();
        const picker = page.getByRole("dialog", { name: "Add an account" });
        await picker.getByRole("searchbox", { name: "Search providers…" }).fill("Tencent");
        await picker.getByRole("button", { name: "Tencent TokenHub" }).click();
        const form = page.getByRole("dialog", { name: "Add provider" });
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-revoked");
        const added = await saveAndRead(form, () =>
          form.getByRole("button", { name: "Save provider", exact: true }).click(),
        );
        expect(added.text).toMatch(/Authentication failed/u);
        expect(await form.isVisible()).toBe(true);
        expect(await form.getByRole("textbox", { name: "API key" }).isEditable()).toBe(true);
      },
    );
  });
});
