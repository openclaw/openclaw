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
const phaseReceipts: Array<Record<string, string | number | boolean>> = [];
const phaseReceipt = (phase: string, fields: Record<string, string | number | boolean> = {}) => {
  if (phaseReceipts.length < 512) {
    phaseReceipts.push({ phase, at: Date.now(), ...fields });
  }
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
          phaseReceipt("upstream-request", { models: request.url === "/v1/models" });
          if (request.url === "/v1/models") {
            phaseReceipt("upstream-response", { status: 200 });
            request.resume();
            response.writeHead(200, { "content-type": "application/json" });
            response.end(JSON.stringify({ data: [{ id: "hy4-preview" }, { id: "current" }] }));
            return;
          }
          void buffer(request).then((raw) => {
            const key = (request.headers.authorization ?? "").replace(/^Bearer /u, "");
            const failure = STATUS_BY_KEY[key];
            if (failure) {
              phaseReceipt("upstream-response", { status: failure[0] });
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
  await scope.evaluate((element) => {
    const receipts: Array<{ phase: string; at: number; checking?: boolean; settled?: boolean }> =
      [];
    let armed = false;
    let last = "";
    const record = (phase: string) => {
      const checking = /Checking/u.test(element.textContent ?? "");
      const settled = [
        ...element.querySelectorAll(".settings-message, [role='alert'], [role='status']"),
      ].some(
        (message) =>
          /API key saved|Added|verified|rejected|failed|no access|overloaded|error/i.test(
            message.textContent ?? "",
          ) && message.getClientRects().length > 0,
      );
      const state = `${checking}:${settled}`;
      if (receipts.length < 32 && (phase !== "ui-state" || state !== last)) {
        receipts.push({ phase, at: Date.now(), checking, settled });
        last = state;
      }
    };
    const click = (event: Event) => {
      const button = event.target instanceof Element ? event.target.closest("button") : null;
      if (button && /^(Save|Save provider)$/u.test(button.textContent?.trim() ?? "")) {
        armed = true;
        record("browser-click");
      }
    };
    const submit = () => {
      if (armed) {
        record("browser-submit");
      }
    };
    element.addEventListener("click", click, true);
    element.addEventListener("submit", submit, true);
    const observer = new MutationObserver(() => {
      if (armed) {
        record("ui-state");
      }
    });
    observer.observe(element, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    (window as typeof window & { keySavePhase?: () => typeof receipts }).keySavePhase = () => {
      observer.disconnect();
      element.removeEventListener("click", click, true);
      element.removeEventListener("submit", submit, true);
      return receipts;
    };
  });
  phaseReceipts.length = 0;
  const started = Date.now();
  phaseReceipt("node-before-click");
  await save();
  phaseReceipt("node-click-return");
  const message = scope.locator(".settings-message, [role='alert'], [role='status']").filter({
    hasText: SETTLED,
  });
  await message.first().waitFor({ timeout: 30_000 });
  phaseReceipt("node-message-observed");
  // Let a check that follows the save finish before reading the final message.
  await expect.poll(async () => scope.getByText(/Checking/u).count(), { timeout: 30_000 }).toBe(0);
  phaseReceipt("node-checking-settled");
  const text = (await scope.textContent()) ?? "";
  const ms = Date.now() - started;
  phaseReceipt("node-text-read");
  const browser = await scope.evaluate(() => {
    const holder = window as typeof window & { keySavePhase?: () => unknown };
    const result = holder.keySavePhase?.();
    delete holder.keySavePhase;
    return result;
  });
  console.error(
    "KEY_SAVE_PHASE " + JSON.stringify({ started, ms, browser, receipts: phaseReceipts }),
  );
  return { text, ms };
}

suite.define(() => {
  it("reports a rejected key where it was entered and keeps the field editable", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        page.on("websocket", (socket) => {
          const methods = new Map<string, string>();
          const allowed = new Set([
            "models.authSetApiKey",
            "models.probe",
            "models.authStatus",
            "models.list",
            "config.get",
            "config.schema",
            "config.schema.lookup",
            "config.applyStatus",
          ]);
          socket.on("framesent", ({ payload }) => {
            try {
              const frame = JSON.parse(String(payload));
              if (
                frame.type === "req" &&
                allowed.has(frame.method) &&
                typeof frame.id === "string"
              ) {
                methods.set(frame.id, frame.method);
                phaseReceipt("rpc-request", { method: frame.method });
              }
            } catch {
              /* Non-JSON protocol frames carry no diagnostic evidence. */
            }
          });
          socket.on("framereceived", ({ payload }) => {
            try {
              const frame = JSON.parse(String(payload));
              const method = methods.get(frame.id);
              if (frame.type === "res" && method) {
                methods.delete(frame.id);
                phaseReceipt("rpc-response", { method, ok: frame.ok === true });
              }
            } catch {
              /* Retain no response payloads or error strings. */
            }
          });
        });
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
