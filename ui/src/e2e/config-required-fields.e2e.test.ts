// Control UI tests cover required field semantics through the built Settings page.
import { expect, it } from "vitest";
import { buildConfigSchemaCore } from "../../../src/config/schema.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  configSnapshot,
  createConfigSuite,
  pageRunner,
  revealControl,
  settingsPageOptions,
} from "./config-composer-fixtures.test-support.ts";

const suite = createConfigSuite("Control UI required Settings fields");
const withPage = pageRunner(suite, settingsPageOptions);

suite.define(() => {
  it("exposes a required storage provider without changing keyboard autosave", async () => {
    const config = {
      storage: {
        locations: {
          example: { provider: "filesystem", settings: { path: "/example" }, encryption: "none" },
        },
      },
    };
    await withPage(async ({ page, context }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(config, "required-fields", true),
          "config.schema": buildConfigSchemaCore(),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/advanced?section=storage&advanced=1`);
      const provider = page.getByRole("textbox", { name: "Storage Provider", exact: true });
      await revealControl(provider);
      await provider.focus();
      expect(await provider.evaluate((element) => element === document.activeElement)).toBe(true);
      expect(await provider.getAttribute("aria-required")).toBe("true");
      const session = await context.newCDPSession(page);
      const tree = await session.send("Accessibility.getFullAXTree");
      expect(
        tree.nodes.some(
          (node) =>
            node.role?.value === "textbox" &&
            node.name?.value === "Storage Provider" &&
            node.properties?.some(
              (property) => property.name === "required" && property.value.value === true,
            ),
        ),
      ).toBe(true);
      await session.detach();
      expect(await provider.getAttribute("required")).toBeNull();
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await gateway.deferNext("config.set");
      await provider.fill("example-provider");
      await provider.press("Tab");
      const request = await gateway.waitForRequest("config.set");
      expect(request.params).toMatchObject({ baseHash: "required-fields" });
      const params = request.params;
      if (!params || typeof params !== "object" || !("raw" in params)) {
        throw new Error("Missing config.set raw payload");
      }
      expect(JSON.parse(String(params.raw))).toEqual({
        storage: {
          locations: {
            example: { ...config.storage.locations.example, provider: "example-provider" },
          },
        },
      });
      await gateway.resolveDeferred("config.set");
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Saved");
    });
  });

  it("marks required short enum choices without changing keyboard autosave", async () => {
    const config = { database: { families: { state: { engine: "sqlite" } } } };
    await withPage(async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configSnapshot(config, "required-choice", true),
          "config.schema": buildConfigSchemaCore(),
        },
      });
      await page.goto(`${suite.server.baseUrl}settings/advanced?section=database&advanced=1`);
      const choice = page
        .getByRole("radiogroup", {
          name: "Family Database Engine",
          exact: true,
          includeHidden: true,
        })
        .filter({ has: page.locator("input:checked") });
      await revealControl(choice);
      const sqlite = choice.getByRole("radio", { name: "sqlite", exact: true });
      await sqlite.focus();
      expect(await choice.getAttribute("aria-required")).toBe("true");
      expect(await choice.locator("[required]").count()).toBe(0);
      const optional = page.getByRole("radiogroup", { name: "Database Engine", exact: true });
      expect(await optional.getAttribute("aria-required")).toBeNull();
      expect(await gateway.getRequests("config.set")).toHaveLength(0);
      await gateway.deferNext("config.set");
      await sqlite.press("ArrowRight");
      const request = await gateway.waitForRequest("config.set");
      expect(request.params).toMatchObject({ baseHash: "required-choice" });
      const params = request.params;
      if (!params || typeof params !== "object" || !("raw" in params)) {
        throw new Error("Missing config.set raw payload");
      }
      expect(JSON.parse(String(params.raw))).toEqual({
        database: { families: { state: { engine: "postgres" } } },
      });
      await gateway.resolveDeferred("config.set");
      await expect
        .poll(() => page.locator("openclaw-settings-save-indicator").textContent())
        .toContain("Saved");
    });
  });
});
