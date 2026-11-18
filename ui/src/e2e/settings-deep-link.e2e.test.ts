// Control UI tests cover links that open one setting: arrival, mark, focus and no writes.
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_SETTINGS_PLACES } from "../../../src/shared/control-ui-settings-places.ts";
import { pathForRoute } from "../app-route-paths.ts";
import { sourceConfigSnapshot } from "../lib/config/config-snapshot.test-support.ts";
import { configPageForSection } from "../pages/config/config-sections.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createConfigSuite,
  pageRunner,
  settingsPageOptions,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Control UI settings deep link mocked Gateway E2E");
const withPage = pageRunner(suite, settingsPageOptions);

const models = [
  { id: "gpt-5.5", name: "GPT-5.5", provider: "openai", available: true },
  { id: "gpt-5-mini", name: "GPT-5 mini", provider: "openai", available: true },
];
const gatewayScenario = {
  models,
  methodResponses: {
    "config.get": sourceConfigSnapshot(
      { agents: { defaults: { model: "openai/gpt-5.5" } } },
      "settings-deep-link-e2e",
    ),
    "models.list": { models },
    "models.authStatus": {
      ts: Date.now(),
      providers: [
        {
          provider: "openai",
          displayName: "OpenAI",
          status: "ok",
          profiles: [{ profileId: "openai:alex", type: "oauth", status: "ok" }],
        },
      ],
    },
    "usage.status": { updatedAt: Date.now(), providers: [] },
    "sessions.usage": { aggregates: { byProvider: [] } },
  },
};
const WRITE_METHODS = ["config.set", "config.patch", "config.apply"] as const;
const settingRow = (page: Page, id: string) => page.locator(`[id="${id}"]`);
type PlaceId = keyof typeof CONTROL_UI_SETTINGS_PLACES;
type Place = { path: string; agent?: true; agentPanel?: string; hash?: string };
/** The link a message carries for a place, as the server will build it. */
function placeHref(id: PlaceId) {
  const place: Place = CONTROL_UI_SETTINGS_PLACES[id];
  const agent = place.agent ? `/main${place.agentPanel ? `/${place.agentPanel}` : ""}` : "";
  return `${place.path}${agent}${place.hash ? `#${place.hash}` : ""}`;
}
const placeUrl = (id: PlaceId) => `${suite.server.baseUrl}${placeHref(id).slice(1)}`;

async function expectArrival(page: Page, row: Locator, title: string) {
  await expect.poll(() => row.getAttribute("data-settings-arrival")).toBe("");
  // The row sits clear of the viewport edges, with its neighbors around it.
  const box = (await row.boundingBox())!;
  expect(box.y).toBeGreaterThan(40);
  expect(box.y + box.height).toBeLessThan(page.viewportSize()!.height - 40);
  expect(await row.evaluate((element) => element === document.activeElement)).toBe(true);
  expect(await row.locator(".settings-row__title").first().textContent()).toContain(title);
  expect(await row.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("inset");
}

suite.define(() => {
  it("opens the linked setting from a chat message without changing it", async () => {
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...gatewayScenario,
        historyMessages: [
          { role: "user", content: [{ type: "text", text: "Summarize the release notes." }] },
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: `I could not finish this reply. The model stopped responding and no fallback model is set up.\n\n[Set up a fallback model](${placeHref("models.fallbacks")})`,
              },
            ],
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByRole("link", { name: "Set up a fallback model" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/model-providers");
      expect(new URL(page.url()).hash).toBe("#agents.defaults.model.fallbacks");
      const row = settingRow(page, "agents.defaults.model.fallbacks");
      await expectArrival(page, row, "Fallback model");
      // A row that is not a control is named for screen readers by its title.
      expect(await row.getAttribute("role")).toBe("group");
      expect(await row.getAttribute("aria-labelledby")).toBe(
        "agents.defaults.model.fallbacks-title",
      );
      // The wash fades; the edge bar stays until the reader acts.
      await page.waitForTimeout(2600);
      expect(await row.getAttribute("data-settings-arrival")).toBe("");
      await page.getByRole("heading", { name: "Defaults for all agents" }).click();
      await expect.poll(() => row.getAttribute("data-settings-arrival")).toBeNull();
      for (const method of WRITE_METHODS) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });

  it("keeps a still mark when the reader prefers reduced motion", async () => {
    await withPage(
      async ({ page }) => {
        await installMockGateway(page, gatewayScenario);
        await page.goto(placeUrl("models.fallbacks"));
        const row = settingRow(page, "agents.defaults.model.fallbacks");
        await expectArrival(page, row, "Fallback model");
        const style = await row.evaluate((element) => {
          const computed = getComputedStyle(element);
          return { animation: computed.animationName, background: computed.backgroundColor };
        });
        expect(style.animation).toBe("none");
        expect(style.background).not.toBe("rgba(0, 0, 0, 0)");
      },
      { reducedMotion: "reduce" },
    );
  });

  it("opens every listed place on the complete config schema", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const schema = buildConfigSchemaCore();
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, {
        ...gatewayScenario,
        methodResponses: { ...gatewayScenario.methodResponses, "config.schema": schema },
      });
      for (const id of Object.keys(CONTROL_UI_SETTINGS_PLACES) as PlaceId[]) {
        const place: Place = CONTROL_UI_SETTINGS_PLACES[id];
        await page.goto(placeUrl(id));
        if (!place.hash) {
          await expect
            .poll(() => new URL(page.url()).pathname, { message: id })
            .toBe(new URL(placeUrl(id)).pathname);
          continue;
        }
        const target = settingRow(page, place.hash);
        if (id === "agents.modelPolicy") {
          // The config defines no model policy, so its fields have no rows; the link lands
          // on the policy itself.
          const policy = settingRow(page, "agents.defaults.modelPolicy");
          await expect
            .poll(() => policy.getAttribute("data-settings-arrival"), { message: id })
            .toBe("");
          continue;
        }
        await target.waitFor({ state: "visible" });
        if (await target.evaluate((element) => element.classList.contains("settings-row"))) {
          await expect
            .poll(() => target.getAttribute("data-settings-arrival"), { message: id })
            .toBe("");
        }
        await expect
          .poll(async () => (await target.boundingBox())!.y, { message: id })
          .toBeLessThan(page.viewportSize()!.height);
      }
      // A key press ends the mark and edits nothing.
      await page.goto(placeUrl("gateway.publicOrigin"));
      const row = settingRow(page, "gateway.publicOrigin");
      await expectArrival(page, row, "Public origin");
      await page.keyboard.press("Shift");
      await expect.poll(() => row.getAttribute("data-settings-arrival")).toBeNull();
      for (const method of WRITE_METHODS) {
        expect(await gateway.getRequests(method)).toHaveLength(0);
      }
    });
  });

  it("gives every schema setting row one unique ID", async () => {
    const { buildConfigSchemaCore } = await import("../../../src/config/schema.ts");
    const schema = buildConfigSchemaCore();
    const sections = Object.keys(schema.schema.properties ?? {}).flatMap((section) => {
      const routeId = configPageForSection(section);
      // Memory, Plugins and Updates build their own rows; those get IDs with the other
      // hand-built pages.
      return routeId === "memory" || routeId === "plugin-settings" || routeId === "updates"
        ? []
        : [{ section, path: pathForRoute(routeId) }];
    });
    expect(sections.length).toBeGreaterThan(20);
    await withPage(async ({ page }) => {
      await installMockGateway(page, {
        ...gatewayScenario,
        methodResponses: { ...gatewayScenario.methodResponses, "config.schema": schema },
      });
      const failures: string[] = [];
      let checked = 0;
      for (const { section, path } of sections) {
        const formId = `config-section-${section}`;
        await page.goto(
          `${suite.server.baseUrl}${path.slice(1)}?section=${section}&advanced=1#${formId}`,
        );
        // Sections a page replaces with its own editor render no schema form.
        const rendered = await page
          .locator(`[id="${formId}"] .settings-row`)
          .first()
          .waitFor({ timeout: 4000 })
          .then(
            () => true,
            () => false,
          );
        if (!rendered) {
          continue;
        }
        const audit = () =>
          page.evaluate((sectionElementId) => {
            const element = document.getElementById(sectionElementId);
            // The page replaces the form once while its first reads settle.
            if (!element) {
              return null;
            }
            // A setting row names itself. The disclosure that reveals advanced rows is not a
            // setting, and a map without a label of its own is named by its section.
            const rows = [...element.querySelectorAll<HTMLElement>(".settings-row")].filter(
              (row) => {
                const title = row.querySelector(
                  ":scope > .settings-row__text > .settings-row__title",
                );
                return (
                  title &&
                  !row.classList.contains("settings-disclosure__summary") &&
                  !(
                    row.matches(".cfg-map > .cfg-collection-row") &&
                    title.textContent?.trim() === "Custom entries"
                  )
                );
              },
            );
            // A setting with fields in both groups shows its header in each; a link opens
            // the first. Within one group an ID names one row.
            const ids = rows.map(
              (row) =>
                `${row.closest(".config-advanced-disclosure") ? "advanced" : "common"} ${row.id}`,
            );
            return {
              unnamed: rows
                .filter((row) => !row.id)
                .map((row) => row.querySelector(".settings-row__title")!.textContent!.trim()),
              duplicates: [...new Set(ids.filter((key, index) => ids.indexOf(key) !== index))],
              foreign: rows
                .map((row) => row.id)
                .filter((rowId) => rowId && !rowId.startsWith(`${element.id.slice(15)}.`)),
            };
          }, formId);
        let result = await audit();
        for (let attempt = 0; attempt < 10 && !result; attempt += 1) {
          await page.waitForTimeout(200);
          result = await audit();
        }
        if (!result) {
          continue;
        }
        checked += 1;
        for (const [problem, values] of Object.entries(result)) {
          if (values.length > 0) {
            failures.push(`${section}: ${problem} ${values.slice(0, 8).join(", ")}`);
          }
        }
      }
      expect(failures).toEqual([]);
      expect(checked).toBeGreaterThan(15);
    });
  });
});
