import { describe, expect, it, onTestFinished, vi } from "vitest";
import { updateConfigFormValue } from "../lib/config/config-draft-model.ts";
import { createInitialConfigState } from "../lib/config/config-state-model.ts";
import { renderAnalyzedFormFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { analyzeConfigSchema } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config map rename feedback", () => {
  it.each([
    { kind: "duplicate", attempt: "backup", reason: "already in use" },
    { kind: "reserved", attempt: "declared", reason: "already in use" },
    { kind: "schema", attempt: "bad/key", reason: "matches this setting's constraints" },
    { kind: "redacted", attempt: "renamed", reason: "stored secret" },
    { kind: "empty", attempt: "  ", reason: "matches this setting's constraints" },
    { kind: "parent", attempt: "renamed", reason: "Review its documentation and constraints" },
  ])(
    "explains a rejected $kind rename after restoring the valid key",
    ({ kind, attempt, reason }) => {
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: {
          aliases: {
            type: "object",
            properties: { declared: { type: "string" } },
            ...(kind === "parent" ? { const: { primary: "west", backup: "east" } } : {}),
            propertyNames: { type: "string", pattern: "^[a-z]+$" },
            additionalProperties: { type: "string" },
          },
        },
      });
      const value = {
        aliases: {
          primary: kind === "redacted" ? "__OPENCLAW_REDACTED__" : "west",
          backup: "east",
        },
      };
      const state = createInitialConfigState();
      state.configSchema = analysis.schema;
      state.configForm = structuredClone(value);
      const onPatch = vi.fn((path: Array<string | number>, next: unknown) =>
        updateConfigFormValue(state, path, next),
      );
      const container = document.createElement("div");
      document.body.append(container);
      onTestFinished(() => container.remove());
      const renderValue = () =>
        renderAnalyzedFormFixture(container, analysis, { value: state.configForm, onPatch });
      renderValue();
      const key = expectElement(
        container.querySelector<HTMLInputElement>('[aria-label="Key: primary"]'),
        "existing key",
      );
      key.value = attempt;
      key.dispatchEvent(new Event("change", { bubbles: true }));
      flush();
      expect(key.value).toBe("primary");
      expect(key.validity.valid).toBe(true);
      expect(key.getAttribute("aria-invalid")).not.toBe("true");
      const feedback = expectElement(
        document.getElementById(key.getAttribute("aria-describedby") ?? ""),
        "associated rename feedback",
      );
      expect(feedback.hidden).toBe(false);
      expect(feedback.getAttribute("role")).toBe("alert");
      expect(feedback.textContent).toContain("Rename not applied");
      expect(feedback.textContent).toContain("original key was kept");
      expect(feedback.textContent).toContain(reason);
      expect(feedback.textContent).not.toContain("__OPENCLAW_REDACTED__");
      expect(feedback.textContent).not.toContain("west");
      expect(onPatch).not.toHaveBeenCalled();
      expect(state.configForm).toEqual(value);
      renderValue();
      expect(feedback.hidden).toBe(false);
      key.focus();
      expect(document.activeElement).toBe(key);
      expect(document.getElementById(key.getAttribute("aria-describedby") ?? "")).toBe(feedback);
      key.value = "corrected";
      key.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expect(key.value).toBe("corrected");
      expect(feedback.hidden).toBe(true);
      expect(key.getAttribute("aria-describedby")).toBeNull();
      key.dispatchEvent(new Event("change", { bubbles: true }));
      flush();
      if (kind === "redacted" || kind === "parent") {
        expect(key.value).toBe("primary");
        expect(feedback.textContent).toContain(reason);
        expect(onPatch).not.toHaveBeenCalled();
        expect(state.configForm).toEqual(value);
      } else {
        expect(onPatch).toHaveBeenCalledExactlyOnceWith(["aliases"], {
          corrected: "west",
          backup: "east",
        });
        expect(feedback.hidden).toBe(true);
      }
    },
  );
});
