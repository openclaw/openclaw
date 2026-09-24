import { render } from "lit";
import { describe, expect, it, vi } from "vitest";
import {
  renderAnalyzedFormFixture,
  renderTextInputFixture,
} from "../test-helpers/config-form-fixtures.ts";
import { analyzeConfigSchema, renderNode } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form primitive union integrity", () => {
  it.each(
    [false, true].flatMap((maskSensitive) => [
      { maskSensitive, initial: undefined },
      { maskSensitive, initial: "~/.openclaw/usage-footer.json" },
    ]),
  )(
    "renderNode preserves inline objects in ordinary unions (maskSensitive=$maskSensitive, initial=$initial)",
    ({ maskSensitive, initial }) => {
      const container = document.createElement("div");
      const onPatch = vi.fn();
      const analysis = analyzeConfigSchema({
        anyOf: [{ type: "string" }, { type: "object", additionalProperties: {} }],
      });
      render(
        renderNode({
          schema: analysis.schema!,
          value: initial,
          path: ["messages", "usageTemplate"],
          hints: {},
          unsupported: new Set(analysis.unsupportedPaths),
          disabled: false,
          maskSensitive,
          onPatch,
        }),
        container,
      );
      const editor = expectElement(
        container.querySelector<HTMLTextAreaElement>("textarea"),
        "typed inline-object editor",
      );
      const template = { output: { default: [{ text: "usage" }] } };
      editor.value = JSON.stringify(template);
      editor.dispatchEvent(new Event("input", { bubbles: true }));
      editor.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(["messages", "usageTemplate"], template);
    },
  );

  it.each(["string-first", "object-first"])(
    "edits string/object credentials without converting reference or object values (%s)",
    (syntax) => {
      const container = document.createElement("div");
      const onPatch = vi.fn();
      const credential = {
        type: syntax === "string-first" ? ["string", "object"] : ["object", "string"],
        minLength: 3,
      };
      const analysis = analyzeConfigSchema({
        type: "object",
        properties: { credentials: { type: "object", properties: { token: credential } } },
      });
      const renderValue = (token: unknown) =>
        render(
          renderNode({
            schema: analysis.schema!,
            value: { credentials: { token } },
            path: [],
            hints: { "credentials.token": { sensitive: true } },
            unsupported: new Set(analysis.unsupportedPaths),
            disabled: false,
            rawAvailable: false,
            maskSensitive: true,
            onPatch,
          }),
          container,
        );

      renderValue(undefined);
      const input = expectElement(
        container.querySelector<HTMLInputElement>("input"),
        "credential input",
      );
      expect(input.type).toBe("password");
      input.value = "x";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).not.toHaveBeenCalled();
      input.value = "synthetic-key";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(["credentials", "token"], "synthetic-key");
      renderValue("synthetic-key");
      expect(input.readOnly).toBe(false);
      expect(input.type).toBe("password");

      for (const source of ["env", "file", "exec"]) {
        onPatch.mockClear();
        renderValue({ source, provider: "default", id: "synthetic-reference" });
        const reference = expectElement(
          container.querySelector<HTMLInputElement>("input"),
          "reference input",
        );
        expect(reference.value).toBe("");
        expect(reference.readOnly).toBe(true);
        expect(reference.placeholder).toContain("edit the config file directly");
        reference.value = "replacement";
        reference.dispatchEvent(new Event("input", { bubbles: true }));
        reference.dispatchEvent(new Event("change", { bubbles: true }));
        expect(onPatch).not.toHaveBeenCalled();
      }

      renderValue({ nested: "structured" });
      expect(container.querySelector("textarea")).not.toBeNull();
      expect(container.querySelector("input")).toBeNull();
    },
  );

  it.each(["anyOf", "type-array"])(
    "preserves the current branch type in %s primitive unions",
    (syntax) => {
      const container = document.createElement("div");
      const onPatch = vi.fn();
      const schema =
        syntax === "anyOf"
          ? { anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }] }
          : { type: ["string", "number", "boolean"] };
      const renderValue = (value: unknown, defaultValue?: unknown) => {
        const analysis = analyzeConfigSchema({
          type: "object",
          properties: {
            providerOptions: {
              type: "object",
              properties: {
                deepgram: {
                  type: "object",
                  properties: {
                    temperature:
                      defaultValue === undefined ? schema : { ...schema, default: defaultValue },
                  },
                },
              },
            },
          },
        });
        expect(analysis.unsupportedPaths).toEqual([]);
        renderAnalyzedFormFixture(container, analysis, {
          value: { providerOptions: { deepgram: { temperature: value } } },
          onPatch,
        });
        return expectElement(
          container.querySelector<HTMLInputElement>("input[type='text']"),
          "mixed primitive union input",
        );
      };

      let input = renderValue(42);
      input.value = "43";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], 43);

      onPatch.mockClear();
      input = renderValue(1);
      input.value = "1.0000000000000001";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      expect(onPatch).not.toHaveBeenCalled();
      expect(input.getAttribute("aria-invalid")).toBe("true");
      expect(input.value).toBe("1.0000000000000001");

      onPatch.mockClear();
      input = renderValue("42");
      input.value = "43";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(
        ["providerOptions", "deepgram", "temperature"],
        "43",
      );

      onPatch.mockClear();
      input = renderValue(undefined);
      input.value = "43";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], 43);

      onPatch.mockClear();
      input = renderValue(undefined, 42);
      input.value = "43";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(["providerOptions", "deepgram", "temperature"], 43);

      onPatch.mockClear();
      input = renderValue(undefined, "42");
      input.value = "43";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(
        ["providerOptions", "deepgram", "temperature"],
        "43",
      );

      onPatch.mockClear();
      input = renderValue("false");
      input.value = "true";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(
        ["providerOptions", "deepgram", "temperature"],
        "true",
      );

      onPatch.mockClear();
      input = renderValue(false);
      input.value = "true";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(
        ["providerOptions", "deepgram", "temperature"],
        true,
      );

      onPatch.mockClear();
      const identifier = "1048113311314608148";
      input = renderValue(undefined);
      input.value = identifier;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenLastCalledWith(
        ["providerOptions", "deepgram", "temperature"],
        identifier,
      );
    },
  );

  it.each(
    ["anyOf", "type-array"].flatMap((syntax) => [
      { syntax, initial: undefined, branch: "unset" },
      { syntax, initial: 0, branch: "number" },
    ]),
  )(
    "keeps an initial $branch branch stable while an identifier is typed with $syntax",
    ({ syntax, initial }) => {
      const container = document.createElement("div");
      document.body.append(container);
      const identifier = "1048113311314608148";
      const analysis = analyzeConfigSchema(
        syntax === "anyOf"
          ? { anyOf: [{ type: "string", pattern: "^[0-9]{19}$" }, { type: "number" }] }
          : { type: ["string", "number"], pattern: "^[0-9]{19}$" },
      );
      expect(analysis.unsupportedPaths).toEqual([]);
      const schema = analysis.schema!;
      const patches: unknown[] = [];
      let persisted: unknown = initial;
      let value: unknown = initial;

      const renderValue = () => {
        renderTextInputFixture(container, {
          schema,
          value,
          path: ["allowFrom"],
          inputType: "text",
          onPatch: (_path, nextValue) => {
            patches.push(nextValue);
            persisted = nextValue;
            value = nextValue;
            // Model application immediately refreshes the rendered field.
            renderValue();
          },
        });
      };

      try {
        renderValue();
        let input = expectElement(
          container.querySelector<HTMLInputElement>("input[type='text']"),
          "incremental string-number input",
        );
        input.focus();
        input.value = "";
        for (const [index, digit] of Array.from(identifier).entries()) {
          input.value += digit;
          input.dispatchEvent(new Event("input", { bubbles: true }));
          // A background refresh can land even when the prefix is not yet a
          // valid string branch; the focused edit must survive that repaint.
          renderValue();
          input = expectElement(
            container.querySelector<HTMLInputElement>("input[type='text']"),
            `incremental string-number input ${index + 1}`,
          );
        }

        expect(patches.length).toBeGreaterThan(1);
        expect(patches.slice(0, -1).every((candidate) => typeof candidate === "number")).toBe(true);
        expect(patches.at(-1)).toBe(identifier);
        expect(persisted).toBe(identifier);
        expect(value).toBe(identifier);
        expect(input.value).toBe(identifier);
        input.blur();
      } finally {
        container.remove();
      }
    },
  );
});
