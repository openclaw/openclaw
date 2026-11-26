import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { buffer } from "node:stream/consumers";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import { reserveTestPortListener } from "../../../src/test-utils/port-claims.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.js";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.js";
import { takeControlUiScreenshotFrame } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.js";
import { expandProvider } from "./model-providers.test-support.ts";
import { respondAsReasoningModel } from "./reasoning-upstream.test-support.js";

const STATUS_BY_KEY: Record<string, [number, string]> = {
  "sk-synthetic-revoked": [401, "Incorrect API key provided"],
  "sk-synthetic-noaccess": [403, "This key has no access to the requested model"],
  "sk-synthetic-servererror": [500, "Internal server error"],
  "sk-synthetic-quota": [
    429,
    "You exceeded your current quota, please check your plan and billing details.",
  ],
};
const firstFailureReplyAt = new Map<string, number>();
let instance: OpenClawTestInstance;
const tempDirs = createTempDirTracker();
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
            response.end(
              JSON.stringify({
                data: [{ id: "hy4-preview" }, { id: "current" }, { id: "gpt-4o-mini" }],
              }),
            );
            return;
          }
          void buffer(request).then((raw) => {
            const key = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
            const failure = STATUS_BY_KEY[key];
            if (failure) {
              if (!firstFailureReplyAt.has(key)) {
                firstFailureReplyAt.set(key, performance.now());
              }
              response.writeHead(failure[0], { "content-type": "application/json" });
              response.end(
                JSON.stringify({
                  error: {
                    message: failure[1],
                    code: key === "sk-synthetic-quota" ? "insufficient_quota" : failure[0],
                  },
                }),
              );
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
    const providerTransport = path.join(tempDirs.make("model-key-provider-"), "transport.mjs");
    await writeFile(
      providerTransport,
      `
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
        if (url.hostname === "api.openai.com") {
          const { dispatcher, ...options } = init ?? {};
          return originalFetch(new Request(${JSON.stringify(baseUrl)} + url.pathname.slice(3) + url.search, input instanceof Request ? input : undefined), options);
        }
        if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
          return originalFetch(input, init);
        }
        throw new Error("Unexpected external request in provider fixture");
      };
      // The guarded-fetch test contract preserves an explicitly installed HTTP stub.
      globalThis.fetch.mock = {};
    `,
    );
    instance = await createOpenClawTestInstance({
      name: "model-key-save-check",
      reserveIdlePort: false,
      env: {
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        VITEST: undefined,
        NODE_ENV: undefined,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${providerTransport}`,
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter((key) => key.endsWith("_API_KEY"))
            .map((key) => [key, undefined]),
        ),
      },
      config: {
        gateway: { controlUi: { enabled: true } },
        agents: { entries: { main: {} }, defaults: { model: "openai/gpt-4o-mini" } },
        plugins: {
          allow: ["tencent", "openai"],
          entries: { openai: { enabled: true }, tencent: { enabled: true } },
        },
        models: {
          providers: {
            openai: {
              apiKey: "sk-synthetic-original",
            },
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
        tempDirs.cleanup();
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

/** Saves through `save` and returns the settled text. */
async function saveAndRead(scope: Locator, save: () => Promise<void>) {
  await save();
  const message = scope.locator(".settings-message, [role='alert'], [role='status']").filter({
    hasText: SETTLED,
  });
  await message.first().waitFor({ timeout: 30_000 });
  // Let a check that follows the save finish before reading the final message.
  await expect.poll(async () => scope.getByText(/Checking/u).count(), { timeout: 30_000 }).toBe(0);
  return (await scope.textContent()) ?? "";
}

suite.define(() => {
  it("shows failed inference instead of catalog Ready and recovers after replacing the key", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        await page.goto(await open("settings/model-providers"));
        await waitForControlUiGatewayReady(page);
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        const row = await expandProvider(page, "openai");
        const status = row.locator(".provider-row__status");
        const replace = async (key: string) => {
          const button = row.getByRole("button", { name: "Replace API key: OpenAI", exact: true });
          if (await button.count()) {
            await button.click();
          }
          await row.getByLabel("API key", { exact: true }).fill(key);
          return saveAndRead(row, () =>
            row.getByRole("button", { name: "Save", exact: true }).click(),
          );
        };
        await expect.poll(() => status.textContent()).toBe("Ready");
        const failed = await replace("sk-synthetic-quota");
        expect(failed).toContain("rate limit");
        expect.soft(await status.textContent()).toBe("Rate limited");
        await row.getByRole("button", { name: "Test access: OpenAI", exact: true }).click();
        await expect
          .poll(() => row.locator(".model-providers__probe-summary").textContent())
          .toBe("Rate limited");
        await expect
          .poll(() =>
            row.getByRole("button", { name: "Test access: OpenAI", exact: true }).isEnabled(),
          )
          .toBe(true);
        if (process.env.OPENCLAW_UI_E2E_RECORD === "1") {
          const frame = await takeControlUiScreenshotFrame(page, page.locator(".shell"), [row], {
            elements: [status],
            animations: "disabled",
          });
          await writeFile(path.join(suite.artifactDir, "provider-check-clean.png"), frame.png);
          await writeFile(
            path.join(suite.artifactDir, "provider-check-bounds.json"),
            JSON.stringify({
              viewport: page.viewportSize(),
              scale: await page.evaluate(() => window.devicePixelRatio),
              bounds: frame.elements[0]!.bounds,
            }),
          );
        }
        expect.soft(await status.textContent()).toBe("Rate limited");
        await row.locator("button.provider-row__summary").click();
        expect(await row.locator(".provider-row__detail").count()).toBe(0);
        expect.soft(await status.textContent()).toBe("Rate limited");
        await expandProvider(page, "openai");
        const recovered = await replace("sk-synthetic-good");
        expect(recovered).toContain("API key saved and verified.");
        await expect.poll(() => status.textContent()).toBe("Ready");
      },
    );
  });

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

        for (const [key, role, reason] of [
          ["sk-synthetic-revoked", "alert", /didn’t accept it\. Authentication failed\./u],
          ["sk-synthetic-noaccess", "alert", /didn’t accept it\. Authentication failed\./u],
          // A 5xx says nothing about the key, so it's reported as an unfinished check.
          [
            "sk-synthetic-servererror",
            "status",
            /check didn’t finish\. The connection check failed\./u,
          ],
        ] as const) {
          await enterKey(key);
          firstFailureReplyAt.delete(key);
          await save();
          // Allow the real Gateway time to commit the key and dispatch the check under CI load.
          await row.getByRole(role).filter({ hasText: reason }).waitFor({ timeout: 6_000 });
          const repliedAt = firstFailureReplyAt.get(key);
          expect(repliedAt, key).toBeDefined();
          expect(performance.now() - repliedAt!, key).toBeLessThan(2_000);
          expect(await row.getByText("API key saved.", { exact: true }).count(), key).toBe(0);
          // A rejected key stays open to correct; an unfinished check closes the saved key's form.
          const fields = row.getByLabel("API key", { exact: true });
          if (key === "sk-synthetic-servererror") {
            await fields.waitFor({ state: "detached", timeout: 2_000 });
          } else {
            expect(await fields.isEditable(), key).toBe(true);
          }
        }

        await enterKey("sk-synthetic-good");
        const good = await saveAndRead(row, save);
        expect(good).toContain("API key saved and verified.");
        expect(await row.getByLabel("API key", { exact: true }).count()).toBe(0);

        // Adding a provider checks the key the same way, inside the add dialog.
        await page.locator("[data-models-catalog-search]").fill("tencent-tokenhub");
        await page.locator('[data-models-catalog-provider="tencent-tokenhub"] button').click();
        const form = page.getByRole("dialog", { name: "Add provider" });
        await form.getByRole("textbox", { name: "API key" }).fill("sk-synthetic-revoked");
        const added = await saveAndRead(form, () =>
          form.getByRole("button", { name: "Save provider", exact: true }).click(),
        );
        expect(added).toMatch(/Authentication failed/u);
        expect(await form.isVisible()).toBe(true);
        expect(await form.getByRole("textbox", { name: "API key" }).isEditable()).toBe(true);
      },
    );
  });
});
