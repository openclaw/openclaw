import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { runQaGatewayFixture } from "../../../test/helpers/qa-gateway-cleanup.ts";
import { createRequireRecord } from "../../../test/helpers/record.js";
import { evaluateControlUiContext } from "../test-helpers/control-ui-e2e-context.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";

const record = createRequireRecord("record", "expected-object-value");
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
let instance: OpenClawTestInstance | undefined;
const suite = createControlUiE2eSuite({
  name: "Advanced Config form with a real built Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    // CI's prebuilt setup binds stamps to clean source and verifies the asset generation.
    // Explicit entrypoint prevents a missing build from falling back to source preparation.
    for (const file of [
      "dist/index.js",
      "dist/.buildstamp",
      "dist/.runtime-postbuildstamp",
      "dist/control-ui/.build-inputs.json",
    ]) {
      expect((await readFile(file)).length, file).toBeGreaterThan(0);
    }
    const owner = await createOpenClawTestInstance({
      name: "config-form-persistence",
      entrypoint: ["dist/index.js"],
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: {
          controlUi: { enabled: true, root: path.resolve("dist/control-ui") },
          reload: { mode: "hybrid" },
        },
        plugins: { allow: [], entries: { crabbox: { enabled: false } } },
        cloudWorkers: {
          profiles: {
            proof: {
              provider: "crabbox",
              install: "bundle",
              settings: {
                provider: "synthetic-proof",
                class: "proof",
                ttl: "8h",
                idleTimeout: "45m",
              },
            },
          },
        },
        cron: { enabled: false },
        logging: { level: "info", consoleLevel: "error" },
      },
    });
    instance = owner;
    try {
      const validation = await owner.cli(["config", "validate", "--json"]);
      expect(validation.code, validation.stdout || validation.stderr).toBe(0);
      await owner.startGateway();
      return { baseUrl: `http://127.0.0.1:${owner.port}/`, close: () => owner.cleanup() };
    } catch (error) {
      return await runQaGatewayFixture(
        async (): Promise<never> => {
          throw error;
        },
        () => owner.cleanup(),
      );
    }
  },
});

suite.define(() => {
  it("persists cloud profile retries after a real stale-hash rejection without allocating workers", async () => {
    const owner = instance;
    if (!owner) {
      throw new Error("Config Gateway fixture was not started");
    }
    const handoff = await owner.cli(["dashboard", "--json"]);
    expect(handoff.code, handoff.stderr).toBe(0);
    const browserUrl = record(JSON.parse(handoff.stdout)).browserUrl;
    if (typeof browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const url = new URL("settings/cloud-workers", browserUrl);
    url.hash = new URL(browserUrl).hash;
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const forbidden: string[] = [];
      let patches = 0;
      let holdCatalog = true;
      const catalogRequests = new Set<string>();
      const catalogReplies: Array<() => void> = [];
      const releaseCatalog = () => {
        holdCatalog = false;
        catalogReplies.splice(0).forEach((send) => send());
      };
      let hold = true;
      let release: (() => void) | undefined;
      const releaseWrite = () => {
        release?.();
        release = undefined;
      };
      await page.routeWebSocket(`ws://127.0.0.1:${owner.port}/**`, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = record(JSON.parse(message.toString()));
          if (frame.type === "req") {
            if (
              frame.method === "environments.list" &&
              typeof frame.id === "string" &&
              record(frame.params).projection === "profiles"
            ) {
              catalogRequests.add(frame.id);
            }
            if (
              ["environments.prepare", "sessions.create", "sessions.dispatch"].includes(
                String(frame.method),
              )
            ) {
              forbidden.push(String(frame.method));
            }
            if (frame.method === "config.patch") {
              patches++;
              if (hold) {
                hold = false;
                release = () => server.send(message);
                return;
              }
            }
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = record(JSON.parse(message.toString()));
          if (
            frame.type === "res" &&
            typeof frame.id === "string" &&
            catalogRequests.delete(frame.id) &&
            holdCatalog
          ) {
            catalogReplies.push(() => socket.send(message));
          } else {
            socket.send(message);
          }
        });
      });
      try {
        expect((await page.goto(url.href))?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        await page.locator(".settings-disclosure > summary").click();
        await page.getByRole("button", { name: "Edit: proof", exact: true }).click();
        const lifetime = page.getByLabel("Max lifetime", { exact: true });
        await lifetime.fill("9h");
        await waitForSettledFormControls(page, [{ locator: lifetime, value: "9h" }]);
        const input = await lifetime.elementHandle();
        await expect.poll(() => catalogReplies.length).toBeGreaterThan(0);
        const save = page.getByRole("button", { name: "Save", exact: true });
        await save.click();
        await expect.poll(() => Boolean(release)).toBe(true);
        expect(patches).toBe(1);
        expect(await lifetime.isDisabled()).toBe(true);
        releaseCatalog();
        await page
          .locator(".settings-row")
          .filter({ has: page.locator("code", { hasText: /^proof$/ }) })
          .getByText(/^(Advertised|Unavailable)$/)
          .waitFor();
        expect(await lifetime.evaluate((element, original) => element === original, input)).toBe(
          true,
        );
        const external = await owner.cli([
          "config",
          "set",
          "cloudWorkers.profiles.proof.settings.ttl",
          "7h",
        ]);
        expect(external.code, external.stderr).toBe(0);
        releaseWrite();
        await page
          .getByRole("alert")
          .filter({ hasText: /changed|reload|conflict/i })
          .waitFor();
        expect(await lifetime.inputValue()).toBe("9h");
        expect(await lifetime.evaluate((element, original) => element === original, input)).toBe(
          true,
        );
        // Reload through the existing config owner after the real server rejects its old hash.
        await evaluateControlUiContext(page, (app) => app.runtimeConfig.refresh());
        await expect.poll(() => save.isEnabled()).toBe(true);
        await save.click();
        await page.getByText("Profile saved", { exact: true }).waitFor();
        const stored = await owner.cli([
          "config",
          "get",
          "cloudWorkers.profiles.proof.settings.ttl",
          "--json",
        ]);
        expect(stored.code, stored.stderr).toBe(0);
        expect(JSON.parse(stored.stdout)).toBe("9h");
        expect((await page.reload())?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        await page.locator(".settings-disclosure > summary").click();
        await page.getByRole("button", { name: "Edit: proof", exact: true }).click();
        expect(await lifetime.inputValue()).toBe("9h");
        const entry = await page
          .locator('script[type="module"][src*="/assets/index-"]')
          .getAttribute("src");
        if (!entry) {
          throw new Error("Gateway did not serve a production entry asset");
        }
        const asset = new URL(entry, page.url());
        const served = await page.request.get(asset.href, {
          headers: { "Accept-Encoding": "identity" },
        });
        expect(served.status()).toBe(200);
        expect(digest(await served.body())).toBe(
          digest(await readFile(path.join("dist/control-ui", asset.pathname.replace(/^\//u, "")))),
        );
        expect(patches).toBe(2);
        expect(forbidden).toEqual([]);
      } finally {
        releaseCatalog();
        releaseWrite();
      }
    });
  });

  it("persists Logging edits across reload, keeps in-flight edits, and rejects a stale hash", async () => {
    const owner = instance;
    if (!owner) {
      throw new Error("Config Gateway fixture was not started");
    }
    const cliJson = async (args: string[]): Promise<unknown> => {
      const result = await owner.cli(args);
      expect(result.code, result.stderr).toBe(0);
      return JSON.parse(result.stdout);
    };
    const handoff = record(await cliJson(["dashboard", "--json"]));
    if (typeof handoff.browserUrl !== "string") {
      throw new Error("Dashboard did not return a browser handoff");
    }
    const url = new URL("settings/advanced?section=logging", handoff.browserUrl);
    url.hash = new URL(handoff.browserUrl).hash;
    await suite.withPage(createControlUiE2eContextOptions(), async ({ page }) => {
      const requests = new Map<string, string>();
      const saves: Array<{ baseHash: unknown; level: unknown }> = [];
      let loadedHash: unknown;
      let schemaReceived = false;
      let hold: "ack" | "write" | undefined;
      let release: (() => void) | undefined;
      const releaseHeldFrame = () => {
        const send = release;
        release = undefined;
        send?.();
      };
      await page.routeWebSocket(`ws://127.0.0.1:${owner.port}/**`, (socket) => {
        const server = socket.connectToServer();
        socket.onMessage((message) => {
          const frame = record(JSON.parse(message.toString()));
          if (
            frame.type === "req" &&
            typeof frame.id === "string" &&
            typeof frame.method === "string"
          ) {
            requests.set(frame.id, frame.method);
            if (frame.method === "config.set") {
              const params = record(frame.params);
              if (typeof params.raw !== "string") {
                throw new Error("Config write is missing raw config");
              }
              saves.push({
                baseHash: params.baseHash,
                level: record(record(JSON.parse(params.raw)).logging).level,
              });
              if (hold === "write") {
                hold = undefined;
                release = () => server.send(message);
                return;
              }
            }
          }
          server.send(message);
        });
        server.onMessage((message) => {
          const frame = record(JSON.parse(message.toString()));
          const method = typeof frame.id === "string" ? requests.get(frame.id) : undefined;
          if (frame.type === "res" && method) {
            requests.delete(String(frame.id));
            if (method === "config.get" && frame.ok) {
              loadedHash = record(frame.payload).hash;
            }
            if (method === "config.schema" && frame.ok) {
              schemaReceived = true;
            }
            // Delay only an actual server reply: no Gateway response is manufactured.
            if (method === "config.set" && hold === "ack") {
              hold = undefined;
              release = () => socket.send(message);
              return;
            }
          }
          socket.send(message);
        });
      });
      try {
        expect((await page.goto(url.toString()))?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        const level = page.getByRole("combobox", { name: "Log level", exact: true });
        const selected = () => level.locator("option:checked").textContent();
        await expect.poll(selected).toBe("Info");
        expect(schemaReceived).toBe(true);
        expect(typeof loadedHash).toBe("string");
        const originalHash = loadedHash;
        const entry = await page
          .locator('script[type="module"][src*="/assets/index-"]')
          .getAttribute("src");
        if (!entry) {
          throw new Error("Gateway did not serve a production entry asset");
        }
        const asset = new URL(entry, page.url());
        const served = await page.request.get(asset.toString(), {
          headers: { "Accept-Encoding": "identity" },
        });
        expect(served.status()).toBe(200);
        expect(digest(await served.body())).toBe(
          digest(await readFile(path.join("dist/control-ui", asset.pathname.replace(/^\//u, "")))),
        );

        hold = "ack";
        await level.selectOption({ label: "Warn" });
        await expect.poll(() => Boolean(release)).toBe(true);
        expect(saves).toEqual([{ baseHash: originalHash, level: "warn" }]);
        expect(await level.isEnabled()).toBe(true);
        await level.selectOption({ label: "Error" });
        releaseHeldFrame();
        // Normal autosaves are silent; observe the existing owner's receipt, read-only.
        await expect
          .poll(() =>
            evaluateControlUiContext(page, (app) => ({
              dirty: app.runtimeConfig.state.configFormDirty,
              status: app.runtimeConfig.state.configAutoSaveStatus,
            })),
          )
          .toEqual({ dirty: false, status: "saved" });
        expect(saves).toHaveLength(2);
        expect(saves[1]).toMatchObject({ level: "error" });
        expect(saves[1]?.baseHash).not.toBe(originalHash);
        expect(await cliJson(["config", "get", "logging.level", "--json"])).toBe("error");
        expect((await page.reload())?.status()).toBe(200);
        await waitForControlUiGatewayReady(page);
        await expect.poll(selected).toBe("Error");

        hold = "write";
        await level.selectOption({ label: "Debug" });
        await expect.poll(() => Boolean(release)).toBe(true);
        // The fixture starts with error. This must be a real revision-changing writer.
        expect(await cliJson(["config", "get", "logging.consoleLevel", "--json"])).toBe("error");
        const external = await owner.cli(["config", "set", "logging.consoleLevel", "warn"]);
        expect(external.code, external.stderr).toBe(0);
        releaseHeldFrame();
        const indicator = page.locator("openclaw-settings-save-indicator");
        await expect.poll(() => indicator.textContent()).toContain("Settings changed elsewhere");
        expect(await cliJson(["config", "get", "logging.level", "--json"])).toBe("error");
        await indicator.getByRole("button", { name: "Reload", exact: true }).click();
        await page
          .getByRole("dialog")
          .getByRole("button", { name: "Discard changes", exact: true })
          .click();
        await expect.poll(selected).toBe("Error");
        expect(await cliJson(["config", "get", "logging.consoleLevel", "--json"])).toBe("warn");
      } finally {
        releaseHeldFrame();
      }
    });
  });
});
