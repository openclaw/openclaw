import { expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import {
  renderAnalyzedFormFixture,
  disposeConfigFormFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { analyzeConfigSchema } from "./config-form.analyze.ts";

it.each(["0", "-"])(
  "steps the unset WhatsApp media limit draft %s instead of the inherited default",
  async (draft) => {
    const container = document.body.appendChild(document.createElement("div"));
    const onPatch = vi.fn();
    const path = ["channels", "whatsapp", "mediaMaxMb"];
    // Input JSON schema from WhatsAppConfigSchema; the source config omits the default.
    const analysis = analyzeConfigSchema({
      type: "object",
      properties: {
        channels: {
          type: "object",
          properties: {
            whatsapp: {
              type: "object",
              properties: {
                mediaMaxMb: {
                  type: "integer",
                  exclusiveMinimum: 0,
                  maximum: Number.MAX_SAFE_INTEGER,
                  default: 50,
                },
              },
            },
          },
        },
      },
    });
    renderAnalyzedFormFixture(container, analysis, {
      value: { channels: { whatsapp: {} } },
      onPatch,
    });
    try {
      const input = container.querySelector<HTMLInputElement>("input[type=number]")!;
      expect(input.value).toBe("");
      expect(input.placeholder).toContain("50");
      await page.elementLocator(input).click();
      await userEvent.keyboard(draft);
      expect(input.value).toBe(draft === "-" ? "" : "0");
      expect(input.validity.badInput).toBe(draft === "-");
      expect(onPatch).not.toHaveBeenCalled();
      await userEvent.keyboard("{ArrowUp}");
      expect(input.value).toBe("1");
      expect(onPatch).toHaveBeenLastCalledWith(path, 1);
    } finally {
      disposeConfigFormFixture(container);
      container.remove();
    }
  },
);
