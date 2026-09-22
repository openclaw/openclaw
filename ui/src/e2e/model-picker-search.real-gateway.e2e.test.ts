import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "../../../test/helpers/openclaw-test-instance.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  takeControlUiViewportScreenshot,
  waitForControlUiProofSurface,
} from "../test-helpers/control-ui-e2e-screenshot.ts";
import { pickerValue } from "../test-helpers/select-picker-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const record = createRequireRecord("record", "expected-object-value");
const models = [
  "anchor",
  "aurora-large",
  "aurora-small",
  "birch",
  "cedar",
  "delta",
  "elm",
  "forest",
  "granite",
  "harbor",
  "iris",
  "juniper",
].map((id) => ({ id, name: id }));
let owner: OpenClawTestInstance;
let proofDir: string | undefined;
const suite = createControlUiE2eSuite({
  name: "Model picker search with a real Gateway",
  startServerBeforeBrowser: true,
  async startServer() {
    owner = await createOpenClawTestInstance({
      name: "model-picker-search",
      env: { OPENCLAW_TEST_MINIMAL_GATEWAY: undefined, VITEST: undefined },
      config: {
        gateway: { controlUi: { enabled: true } },
        plugins: { enabled: false },
        cron: { enabled: false },
        agents: { defaults: { model: "fixture/anchor", modelPolicy: { allow: ["fixture/*"] } } },
        models: {
          catalogRefresh: { enabled: false },
          providers: {
            fixture: {
              api: "openai-completions",
              apiKey: "synthetic-catalog-key",
              baseUrl: "http://127.0.0.1:9/v1",
              models: models.slice(0, 1),
            },
          },
        },
      },
    });
    try {
      await owner.startGateway();
      return {
        baseUrl: `http://127.0.0.1:${owner.port}/`,
        close: async () => {
          const child = owner.child;
          await owner.cleanup();
          if (proofDir) {
            await fs.writeFile(
              path.join(proofDir, "lifecycle.json"),
              JSON.stringify(
                {
                  pid: child?.pid,
                  exitCode: child?.exitCode,
                  signalCode: child?.signalCode,
                  cleanupReturned: true,
                },
                null,
                2,
              ),
            );
          }
        },
      };
    } catch (error) {
      await owner.cleanup();
      throw error;
    }
  },
});

suite.define(() => {
  it("keeps compact choices readable and an unsaved search current through catalog replacement", async () => {
    proofDir = createControlUiE2eArtifactDir("model-picker-public");
    const directory = proofDir;
    const frames: unknown[] = [];
    const commands: unknown[] = [];
    const observations: unknown[] = [];
    const requests = new Map<string, string>();
    const mutations: string[] = [];
    const assets: Array<Promise<unknown>> = [];
    const redact = (text: string) =>
      text
        .replaceAll(owner.gatewayToken, "[synthetic token]")
        .replaceAll(owner.hookToken, "[synthetic token]")
        .replaceAll(owner.homeDir, "[fixture-home]")
        .replaceAll(owner.stateDir, "[fixture-state]")
        .replaceAll(process.cwd(), "[checkout]");
    const cli = async (args: string[]) => {
      const result = await owner.cli(args);
      commands.push({
        args,
        ...result,
        stdout: args[0] === "dashboard" ? "[one-time handoff omitted]" : result.stdout,
      });
      expect(result.code, result.stderr).toBe(0);
      return result.stdout;
    };
    const publish = (nextModels: typeof models) =>
      cli([
        "config",
        "set",
        "models.providers.fixture.models",
        JSON.stringify(nextModels),
        "--strict-json",
        "--replace",
      ]);
    const handoff = record(JSON.parse(await cli(["dashboard", "--json"])));
    if (typeof handoff.browserUrl !== "string") {
      throw new Error("Dashboard browser handoff missing");
    }
    const issued = new URL(handoff.browserUrl);
    const url = new URL("cron", issued);
    url.hash = issued.hash;
    const buildInfo = JSON.parse(await fs.readFile(path.resolve("dist/build-info.json"), "utf8"));
    try {
      await suite.withPage(
        { serviceWorkers: "block", locale: "en-US", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          page.on("response", (response) => {
            const assetUrl = new URL(response.url());
            if (
              assetUrl.origin === issued.origin &&
              /\/assets\/.*\.(?:js|css)$/u.test(assetUrl.pathname)
            ) {
              assets.push(
                response.body().then((body) => ({
                  path: assetUrl.pathname,
                  status: response.status(),
                  sha256: createHash("sha256").update(body).digest("hex"),
                })),
              );
            }
          });
          page.on("websocket", (socket) => {
            socket.on("framesent", ({ payload }) => {
              const frame = record(JSON.parse(payload.toString()));
              if (
                frame.type === "req" &&
                frame.method !== "connect" &&
                typeof frame.id === "string" &&
                typeof frame.method === "string"
              ) {
                requests.set(frame.id, frame.method);
                frames.push({ direction: "sent", frame });
                if (
                  [
                    "config.patch",
                    "config.set",
                    "cron.add",
                    "cron.update",
                    "cron.run",
                    "cron.scratch.set",
                    "sessions.patch",
                  ].includes(frame.method)
                ) {
                  mutations.push(frame.method);
                }
              }
            });
            socket.on("framereceived", ({ payload }) => {
              const frame = record(JSON.parse(payload.toString()));
              if (
                (frame.type === "res" && typeof frame.id === "string" && requests.has(frame.id)) ||
                frame.event === "config.changed" ||
                frame.event === "chat.metadata.changed"
              ) {
                frames.push({ direction: "received", frame });
              }
            });
          });
          const press = async (key: string) => {
            await page.keyboard.press(key);
            observations.push({ action: "keyboard", key });
          };
          // Focus attributes and leaf labels cannot expose inline page scripts.
          const capture = async (label: string, picker: Locator) => {
            const surface = page.locator(".cron-page");
            await waitForControlUiProofSurface(surface, [picker]);
            const menu = await picker.evaluate((element) => {
              const rect = element.querySelector(".picker-select__menu")!.getBoundingClientRect();
              const triggerBounds = element.querySelector("button")!.getBoundingClientRect();
              const active = document.activeElement;
              return {
                trigger: element.querySelector("button")?.getAttribute("aria-label"),
                triggerBounds: {
                  x: triggerBounds.x,
                  y: triggerBounds.y,
                  width: triggerBounds.width,
                  height: triggerBounds.height,
                },
                expanded: element.querySelector("button")?.getAttribute("aria-expanded"),
                query: element.querySelector<HTMLInputElement>(".picker-select__search")?.value,
                placement: element
                  .querySelector("wa-popup")
                  ?.getAttribute("data-current-placement"),
                menu: {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  viewportWidth: innerWidth,
                  viewportHeight: innerHeight,
                  scrollX,
                  scrollY,
                  visualViewport: window.visualViewport
                    ? {
                        width: window.visualViewport.width,
                        height: window.visualViewport.height,
                        offsetLeft: window.visualViewport.offsetLeft,
                        offsetTop: window.visualViewport.offsetTop,
                        scale: window.visualViewport.scale,
                      }
                    : null,
                },
                focused: {
                  tag: active?.tagName,
                  id: active?.id,
                  role: active?.getAttribute("role"),
                  label: active?.getAttribute("aria-label"),
                  activeDescendant: active?.getAttribute("aria-activedescendant"),
                },
                rows: [...element.querySelectorAll<HTMLElement>("[role=option]")].map((row) => {
                  const labelElement = row.querySelector<HTMLElement>(".picker-select__label")!;
                  return {
                    value: row.dataset.value,
                    label: labelElement.textContent ?? "",
                    labelWidth: labelElement.clientWidth,
                    labelScrollWidth: labelElement.scrollWidth,
                    disabled: row.getAttribute("aria-disabled"),
                    selected: row.getAttribute("aria-selected"),
                  };
                }),
              };
            });
            observations.push({
              label,
              menu,
              accessibility: await page.locator("body").ariaSnapshot(),
            });
            await fs.writeFile(
              path.join(directory, `${label}.png`),
              await takeControlUiViewportScreenshot(page, surface, [picker]),
            );
            return menu;
          };
          await page.goto(url.toString());
          await waitForControlUiGatewayReady(page);
          await page.locator('[data-test-id="cron-new-task"]').click();
          const picker = page.locator("openclaw-select-picker:has(#cron-payload-model-picker)");
          const trigger = picker.locator(".picker-select__trigger");
          await expect.poll(() => picker.locator('[data-value="anchor"]').count()).toBe(1);
          await trigger.click();
          await picker.getByRole("listbox").waitFor({ state: "visible" });
          const compact = await capture("compact-desktop", picker);
          expect(compact.query).toBeUndefined();
          for (const row of compact.rows) {
            expect(row.labelScrollWidth, row.label).toBeLessThanOrEqual(row.labelWidth);
          }
          await press("ArrowDown");
          await press("Enter");
          expect(await pickerValue(picker)).toBe("anchor");
          await trigger.click();
          await picker.locator('[data-value=""]').click();
          expect(await pickerValue(picker)).toBe("");

          await publish(models);
          await expect.poll(() => picker.locator('[data-value="aurora-large"]').count()).toBe(1);
          const inventory = await picker
            .locator("[role=option]")
            .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-value")));
          expect(inventory.length).toBeGreaterThan(8);
          await page.locator("#cron-name").fill("Keep this draft");
          await page.locator("#cron-payload-text").fill("Do not submit this automation");
          const writesBeforeSearch = mutations.length;
          await trigger.focus();
          await press("ArrowDown");
          const search = picker.locator(".picker-select__search");
          await search.fill("RoRA");
          const filtered = await capture("draft-reference-search", picker);
          expect(filtered.rows.map((row) => row.value)).toEqual(["aurora-large", "aurora-small"]);
          await press("ArrowDown");
          await press("ArrowUp");
          await capture("draft-highlight", picker);
          expect(mutations).toHaveLength(writesBeforeSearch);
          await search.fill("");
          expect(
            await picker
              .locator("[role=option]")
              .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-value"))),
          ).toEqual(inventory);
          await search.fill("aurora-large");
          await press("Enter");
          expect(await pickerValue(picker)).toBe("aurora-large");
          await capture("draft-selected", picker);
          await trigger.click();
          await picker.locator('[data-value="__openclaw_custom_model__"]').click();
          await page.locator("#cron-payload-model").fill("fixture/not-in-catalog");
          expect(await pickerValue(picker)).toBe("fixture/not-in-catalog");
          await capture("draft-custom", picker);

          await trigger.click();
          await search.fill("granite");
          expect(await picker.locator('[data-value="granite"]').count()).toBe(1);
          await capture("before-catalog-removal", picker);
          await publish(models.filter((model) => model.id !== "granite"));
          await expect.poll(() => picker.locator('[data-value="granite"]').count()).toBe(0);
          expect(await search.inputValue()).toBe("granite");
          await press("Enter");
          expect(await trigger.getAttribute("aria-label")).toBe("Model: fixture/not-in-catalog");
          await capture("after-catalog-removal", picker);
          await press("Escape");
          await page.setViewportSize({ width: 1280, height: 700 });
          const topAnchor = await trigger.boundingBox();
          if (!topAnchor) {
            throw new Error("Model trigger is not visible for the top-opening check");
          }
          await page.mouse.move(
            topAnchor.x + topAnchor.width / 2,
            topAnchor.y + topAnchor.height / 2,
          );
          await page.mouse.wheel(0, topAnchor.y - 530);
          await expect.poll(async () => (await trigger.boundingBox())?.y).toBeGreaterThan(500);
          await press("ArrowDown");
          await expect
            .poll(() => picker.locator("wa-popup").getAttribute("data-current-placement"))
            .toMatch(/^top-/u);
          await capture("draft-top-opening", picker);
          await press("Escape");
          await page.setViewportSize({ width: 390, height: 844 });
          await trigger.click();
          await search.fill("no-matches-741");
          const phone = await capture("draft-phone-no-results", picker);
          expect(phone.menu.scrollX).toBe(0);
          expect(phone.triggerBounds.x).toBeGreaterThanOrEqual(0);
          expect(phone.triggerBounds.x + phone.triggerBounds.width).toBeLessThanOrEqual(
            phone.menu.viewportWidth,
          );
          expect(phone.triggerBounds.y).toBeGreaterThanOrEqual(0);
          expect(phone.triggerBounds.y + phone.triggerBounds.height).toBeLessThanOrEqual(
            phone.menu.viewportHeight,
          );
          expect(phone.menu.x).toBeGreaterThanOrEqual(0);
          expect(phone.menu.x + phone.menu.width).toBeLessThanOrEqual(phone.menu.viewportWidth);
          expect(phone.menu.y).toBeGreaterThanOrEqual(0);
          expect(phone.menu.y + phone.menu.height).toBeLessThanOrEqual(phone.menu.viewportHeight);
          await press("Escape");
          expect(await page.locator("#cron-name").inputValue()).toBe("Keep this draft");
          expect(await page.locator("#cron-payload-text").inputValue()).toBe(
            "Do not submit this automation",
          );
          expect(mutations).toHaveLength(writesBeforeSearch);
          expect(JSON.parse(await cli(["config", "get", "agents.defaults.model", "--json"]))).toBe(
            "fixture/anchor",
          );
        },
      );
    } finally {
      await fs.writeFile(
        path.join(directory, "proof.json"),
        redact(
          JSON.stringify(
            { buildInfo, frames, commands, observations, assets: await Promise.allSettled(assets) },
            null,
            2,
          ),
        ),
      );
      await fs.writeFile(path.join(directory, "gateway.log"), redact(owner.logs()));
    }
  }, 120_000);
});
