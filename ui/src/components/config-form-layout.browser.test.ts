import { html, render } from "lit";
import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import "../styles.css";
import "../styles/settings.css";
import "../styles/config.css";
import { renderNode, type JsonSchema } from "./config-form.ts";
import { renderSettingsGroup, renderSettingsPage } from "./settings-ui.ts";

afterEach(() => document.body.replaceChildren());

it.each([390, 768, 1440])(
  "aligns config controls and keeps collection actions beside their labels at %ipx",
  async (width) => {
    await page.viewport(width, 1200);
    const host = document.createElement("main");
    host.className = "shell--settings";
    document.body.append(host);
    const fields: Array<[string, JsonSchema, unknown]> = [
      ["Name", { type: "string" }, "example"],
      ["Mode", { type: "string", enum: ["a", "b", "c", "d", "e", "f"] }, "a"],
      ["Payload", { anyOf: [{ type: "object" }, { type: "array" }] }, { enabled: true }],
      ["Retries", { type: "integer" }, 2],
      ["Collection", { type: "array", items: { type: "string" } }, ["item"]],
      [
        "Nested collections",
        { type: "array", items: { type: "array", items: { type: "string" } } },
        [["nested item"]],
      ],
      ["Draft", { type: "array", items: { type: "string", pattern: "^[A-Z]+$" } }, []],
    ];
    render(
      renderSettingsPage(
        renderSettingsGroup(
          html`${fields.map(([title, schema, value]) =>
            renderNode({
              schema: { ...schema, title },
              value,
              path: [title],
              hints: {},
              unsupported: new Set(),
              disabled: false,
              onPatch: () => {},
            }),
          )}`,
        ),
      ),
      host,
    );
    await document.fonts.ready;
    const rect = (selector: string) => {
      const element = host.querySelector(selector);
      expect(element, selector).not.toBeNull();
      return element!.getBoundingClientRect();
    };
    const nameControl = rect('[aria-label="Name"]');
    const nameLabel = rect(".settings-group > .settings-row > .settings-row__text");
    for (const label of ["Mode", "Payload"]) {
      const control = rect(`[aria-label="${label}"]`);
      expect(control.left).toBeCloseTo(nameControl.left, 0);
      expect(control.right).toBeCloseTo(nameControl.right, 0);
    }
    const rows = [...host.querySelectorAll(".settings-group > .settings-row")];
    const gaps = rows.map((row) => {
      const text = row.querySelector(".settings-row__text")!.getBoundingClientRect();
      const control = row.querySelector(".settings-row__control")!.getBoundingClientRect();
      if (width < 768) {
        expect(control.top).toBeGreaterThan(text.bottom);
      } else {
        expect(control.left).toBeGreaterThan(text.right);
        expect(control.left).toBeCloseTo(nameControl.left, 0);
        expect(control.right).toBeCloseTo(nameControl.right, 0);
      }
      return control.top - text.bottom;
    });
    if (width < 768) {
      for (const gap of gaps.slice(1)) {
        expect(gap).toBeCloseTo(nameControl.top - nameLabel.bottom, 0);
      }
    }
    for (const header of host.querySelectorAll(".cfg-array .settings-row:has(button)")) {
      const text = header.querySelector(".settings-row__text")!.getBoundingClientRect();
      const actions = header.querySelector(".settings-row__control")!.getBoundingClientRect();
      expect(actions.left).toBeGreaterThan(text.right);
      expect(actions.top).toBeLessThan(text.bottom);
      expect(text.top).toBeLessThan(actions.bottom);
    }
    const item = rect(".cfg-array input");
    expect(item.right).toBeCloseTo(nameControl.right, 0);
    const nestedHeader = rect(".cfg-array .cfg-array .settings-row__text");
    const nestedItem = rect(".cfg-array .cfg-array input");
    expect(nestedHeader.left).toBeLessThanOrEqual(nestedItem.left);
    const draftArray = host.querySelector(".settings-group > .cfg-array:last-child")!;
    await page.elementLocator(draftArray.querySelector("button")!).click();
    await expect.element(host.querySelector<HTMLElement>(".cfg-collection-draft")!).toBeVisible();
    const draftInput = rect(".cfg-collection-draft input");
    expect(draftInput.left).toBeCloseTo(nameLabel.left, 0);
    expect(draftInput.right).toBeCloseTo(nameControl.right, 0);
    expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
  },
);
