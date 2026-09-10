import { render, type ReactiveElement } from "lit";
import { describe, expect, it } from "vitest";
import { updateConfigFormValue } from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { analyzeConfigSchema, renderConfigForm, type JsonSchema } from "./config-form.ts";
import baseStyles from "../styles/base.css?inline";

function mountForm(properties: Record<string, JsonSchema>, values: Record<string, unknown>) {
  const analysis = analyzeConfigSchema({
    type: "object",
    properties: { settings: { type: "object", properties } },
  });
  const state = createInitialConfigState();
  state.configForm = { settings: values };
  const container = document.createElement("div");
  const styles = document.createElement("style");
  styles.textContent = baseStyles;
  container.append(styles);
  // The app root does not scroll; controls need an owned scrolling pane.
  container.style.cssText = "height: 100%; overflow: auto";
  document.body.append(container);
  const renderValue = () => {
    render(
      renderConfigForm({
        schema: analysis.schema,
        uiHints: {},
        unsupportedPaths: analysis.unsupportedPaths,
        value: state.configForm,
        showAdvanced: true,
        onShowAdvanced: () => {},
        onPatch: (path, value) => {
          updateConfigFormValue(state, path, value);
          renderValue();
        },
      }),
      container,
    );
  };
  renderValue();
  return {
    state,
    container,
    close: () => {
      render(null, container);
      container.remove();
    },
  };
}

describe.runIf("__vitest_browser__" in globalThis)("config array row drafts", () => {
  it.each(["scalar removal", "object removal", "unrelated edit"] as const)(
    "preserves the surviving invalid draft after %s through the config draft owner",
    async (scenario) => {
      const { page } = await import("vitest/browser");
      const objectRows = scenario !== "scalar removal";
      const initial = objectRows ? [{ name: "First" }, { name: "Second" }] : ["alpha", "beta"];
      const item = { type: "string", minLength: 2 };
      const { state, container, close } = mountForm(
        {
          enabled: { type: "boolean" },
          values: {
            type: "array",
            items: objectRows ? { type: "object", properties: { name: item } } : item,
          },
        },
        { enabled: false, values: initial },
      );
      try {
        const inputs = () => Array.from(container.querySelectorAll<HTMLInputElement>("input"));
        const second = inputs()[1]!;
        await page.elementLocator(second).fill("x");
        expect(second.getAttribute("aria-invalid")).toBe("true");
        const blurred = new Promise<void>((resolve) => {
          second.addEventListener("blur", () => resolve(), { once: true });
        });
        const action = container.querySelector<HTMLElement>(
          scenario === "unrelated edit" ? "wa-switch" : "button[aria-label='Remove item']",
        )!;
        await page.elementLocator(action).click();
        await blurred;
        const values = scenario === "unrelated edit" ? initial : initial.slice(1);
        await expect
          .poll(() => state.configForm)
          .toEqual({
            settings: { enabled: scenario === "unrelated edit", values },
          });
        const surviving = inputs()[scenario === "unrelated edit" ? 1 : 0]!;
        expect(surviving.value).toBe("x");
        expect(surviving.getAttribute("aria-invalid")).toBe("true");
        if (scenario !== "unrelated edit") {
          await expect
            .poll(() => container.querySelector(".cfg-array")?.contains(document.activeElement))
            .toBe(true);
        }
        await page.elementLocator(surviving).fill("Repaired");
        expect(surviving.getAttribute("aria-invalid")).toBe("false");
        expect(state.configForm).toEqual({
          settings: {
            enabled: scenario === "unrelated edit",
            values: [
              ...(scenario === "unrelated edit" ? initial.slice(0, 1) : []),
              objectRows ? { name: "Repaired" } : "Repaired",
            ],
          },
        });
      } finally {
        close();
      }
    },
  );

  it.each(["array", "map", "object"] as const)(
    "keeps a nested %s draft when an earlier row is removed",
    async (kind) => {
      const { page } = await import("vitest/browser");
      const text = { type: "string", minLength: 2, pattern: "^[a-z]+$" };
      const child: JsonSchema =
        kind === "array"
          ? { type: "array", items: text }
          : kind === "map"
            ? { type: "object", additionalProperties: text }
            : {
                type: "object",
                properties: { first: text, second: text },
                required: ["first", "second"],
              };
      const initial = ["First", "Second"].map((name) =>
        kind === "object" ? { name } : { name, child: kind === "array" ? [] : {} },
      );
      const { state, container, close } = mountForm(
        {
          values: {
            type: "array",
            items: { type: "object", properties: { name: { type: "string" }, child } },
          },
        },
        { values: initial },
      );
      try {
        const hostSelector =
          kind === "object"
            ? "openclaw-config-form-structured-draft"
            : "openclaw-config-form-collection-draft";
        const draft = Array.from(container.querySelectorAll<ReactiveElement>(hostSelector)).at(-1)!;
        await draft.updateComplete;
        const details = draft.querySelector("details") ?? draft.closest("details");
        if (details && !details.open) {
          await page.elementLocator(details.querySelector("summary")!).click();
        }
        if (kind !== "object") {
          await page
            .elementLocator(draft.closest(".cfg-block")!.querySelector("button[aria-controls]")!)
            .click();
        }
        const inputSelector = kind === "object" ? "input" : "[data-collection-draft-value]";
        await expect.poll(() => draft.querySelector(inputSelector)).not.toBeNull();
        const draftText = kind === "object" ? "draft" : "x";
        await page.elementLocator(draft.querySelector(inputSelector)!).fill(draftText);
        await page
          .elementLocator(container.querySelector("button[aria-label='Remove item']")!)
          .click();
        await expect
          .poll(() => state.configForm)
          .toEqual({ settings: { values: initial.slice(1) } });
        await expect
          .poll(
            () =>
              container.querySelector<HTMLInputElement>(`${hostSelector} ${inputSelector}`)?.value,
          )
          .toBe(draftText);
      } finally {
        close();
      }
    },
  );
});
