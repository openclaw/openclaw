// Control UI tests cover the visible reason for an invalid scalar config value.
import { afterEach, describe, expect, it, vi } from "vitest";
import "../styles.css";
import { renderNumberInputFixture } from "../test-helpers/config-form-fixtures.ts";
import { configFieldId } from "./config-form.shared.ts";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");

afterEach(() => {
  document.body.replaceChildren();
});

describe.skipIf(!hasBrowserLayout)("config scalar validation reason", () => {
  it("shows why a value is invalid next to the field and removes it once corrected", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const path = ["gateway", "port"];
    const onPatch = vi.fn();
    renderNumberInputFixture(container, {
      schema: { type: "integer", minimum: 1 },
      value: 8080,
      path,
      onPatch,
    });
    const input = container.querySelector<HTMLInputElement>("input");
    const error = document.getElementById(configFieldId(path, "scalar-error"));
    expect(input).not.toBeNull();
    expect(error).not.toBeNull();
    if (!input || !error) {
      return;
    }

    input.value = "0";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(error.textContent).not.toBe("");
    expect(error.textContent).toBe(input.validationMessage);
    const shown = error.getBoundingClientRect();
    expect(getComputedStyle(error).clip).toBe("auto");
    expect(shown.width).toBeGreaterThan(1);
    expect(shown.height).toBeGreaterThan(1);
    expect(onPatch).not.toHaveBeenCalled();

    input.value = "2";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(error.hidden).toBe(true);
    expect(error.getBoundingClientRect().height).toBe(0);
    expect(onPatch).toHaveBeenCalledWith(path, 2);
  });
});
