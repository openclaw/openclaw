import { describe, expect, it } from "vitest";
import { updateConfigFormValue } from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import {
  renderAnalyzedFormFixture,
  disposeConfigFormFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { analyzeConfigSchema } from "./config-form.analyze.ts";

describe("collection entry draft preservation", () => {
  it.each([undefined, "west", "remote"])(
    "keeps local drafts but clears unmatched external replacement %s",
    async (external) => {
      const { page } = await import("vitest/browser");
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          aliases: {
            type: "object",
            additionalProperties: { type: "string", pattern: "^[a-z]+$", minLength: 2 },
          },
        },
      });
      const state = createInitialConfigState();
      state.configForm = { aliases: { primary: "west" } };
      const container = document.createElement("div");
      document.body.append(container);
      const render = () =>
        renderAnalyzedFormFixture(container, analysis, {
          value: state.configForm,
          onPatch: (path, value) => {
            updateConfigFormValue(state, path, value);
            render();
            return true;
          },
        });
      render();
      try {
        await page.elementLocator(container.querySelector("button[aria-controls]")!).click();
        await page
          .elementLocator(container.querySelector("[data-collection-draft-key]")!)
          .fill("backup");
        await page
          .elementLocator(container.querySelector("[data-collection-draft-value]")!)
          .fill("east");
        const existing = container.querySelector<HTMLInputElement>(
          ".cfg-map .settings-subrows input:not([placeholder=Key])",
        )!;
        await page.elementLocator(existing).fill("north");
        expect(
          container.querySelector<HTMLInputElement>("[data-collection-draft-key]")?.value,
        ).toBe("backup");
        expect(
          container.querySelector<HTMLInputElement>("[data-collection-draft-value]")?.value,
        ).toBe("east");
        if (external) {
          state.configForm = { aliases: { primary: external } };
          render();
          expect(container.querySelector("[data-collection-draft-key]")).toBeNull();
          return;
        }
        await page
          .elementLocator(container.querySelector(".cfg-collection-draft__actions button")!)
          .click();
        expect(state.configForm).toEqual({ aliases: { primary: "north", backup: "east" } });
        expect(container.querySelector("[data-collection-draft-key]")).toBeNull();

        await page.elementLocator(container.querySelector("button[aria-controls]")!).click();
        await page
          .elementLocator(container.querySelector("[data-collection-draft-key]")!)
          .fill("third");
        state.configForm = { aliases: { primary: "remote", backup: "east" } };
        render();
        expect(container.querySelector("[data-collection-draft-key]")).toBeNull();
      } finally {
        disposeConfigFormFixture(container);
        container.remove();
      }
    },
  );
});
