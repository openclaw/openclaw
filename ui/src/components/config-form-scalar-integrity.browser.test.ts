import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderNumberInputFixture,
  renderTextInputFixture,
  renderSelectFixture,
  renderAnalyzedFormFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { query, edit, objectSchema } from "./config-form-integrity.test-support.ts";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import type { JsonSchema } from "./config-form.shared.ts";

type FieldOptions = Omit<Parameters<typeof renderNumberInputFixture>[1], "onPatch">;

function fieldFixture() {
  const container = document.createElement("div");
  const onPatch = vi.fn();
  return {
    container,
    onPatch,
    text: (options: FieldOptions & { inputType?: "text" | "number" }) =>
      renderTextInputFixture(container, { inputType: "text", ...options, onPatch }),
    number: (options: FieldOptions) => renderNumberInputFixture(container, { ...options, onPatch }),
    selectField: (options: FieldOptions & { options: unknown[] }) =>
      renderSelectFixture(container, { ...options, onPatch }),
  };
}

const multilinePlaceholder = "Default guidance.\nSecond line.";
const multilineSchema: JsonSchema = { type: "string", maxLength: 4000 };
const multilineHints = {
  reviewInstructions: {
    label: "Review instructions",
    multiline: true,
    placeholder: multilinePlaceholder,
  },
};

describe("config form scalar integrity", () => {
  it.each([false, true])("edits multiline string hints with commitOnBlur=%s", (commitOnBlur) => {
    const { container, onPatch, text } = fieldFixture();
    const path = ["reviewInstructions"];
    text({
      schema: multilineSchema,
      value: undefined,
      path,
      hints: multilineHints,
      commitOnBlur,
    });
    const textarea = query<HTMLTextAreaElement>(container, "textarea");
    expect(textarea.getAttribute("aria-label")).toBe("Review instructions");
    expect(textarea).toMatchObject({ placeholder: multilinePlaceholder, value: "" });
    expect(onPatch).not.toHaveBeenCalled();
    edit(textarea, "Look for scope drift.\nPreserve required checks.");
    if (commitOnBlur) {
      expect(onPatch).not.toHaveBeenCalled();
      textarea.dispatchEvent(new FocusEvent("blur"));
    }
    expect(onPatch).toHaveBeenLastCalledWith(path, textarea.value);
    textarea.value = "x".repeat(4001);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).toHaveBeenCalledTimes(1);
  });

  it("separates boolean help from its default description", () => {
    const container = document.createElement("div");
    const analysis = analyzeConfigSchema(
      objectSchema({
        runtime: objectSchema({
          enabled: { type: "boolean", default: true, description: "Controls runtime processing." },
        }),
      }),
    );
    renderAnalyzedFormFixture(container, analysis, {
      value: { runtime: { enabled: false } },
      onPatch: vi.fn(),
    });
    expect(container.textContent).toContain("Controls runtime processing. Default: true");
  });

  it.each(["text", "number"] as const)(
    "revalidates a focused %s draft through snapshot refresh without untracked reads",
    (inputType) => {
      const warning = vi.spyOn(console, "warn");
      const { container, text } = fieldFixture();
      document.body.append(container);
      const schema: JsonSchema =
        inputType === "text" ? { type: "string", minLength: 3 } : { type: "integer", minimum: 1 };
      const value = inputType === "text" ? "local-api" : 8080;
      const draft = inputType === "text" ? "x" : "0";
      const refreshedValue = inputType === "text" ? "remote-api" : 9000;
      const renderValue = (current: string | number, sourceIdentity: unknown) => {
        text({
          schema,
          value: current,
          path: ["laboratory", "endpoint"],
          sourceIdentity,
          inputType,
        });
      };
      try {
        renderValue(value, { snapshot: 1 });
        const input = query<HTMLInputElement>(container, "input");
        // A background snapshot must revalidate, not replace, uncommitted native text.
        input.focus();
        input.value = draft;
        renderValue(value, { snapshot: 2 });
        expect(input.value).toBe(draft);
        expect(input.getAttribute("aria-invalid")).toBe("true");
        expect(input.validationMessage).not.toBe("");
        expect(container.querySelector(".cfg-field__error")?.textContent).toBe(
          input.validationMessage,
        );
        input.blur();
        renderValue(refreshedValue, { snapshot: 3 });
        expect(input.value).toBe(String(refreshedValue));
        expect(input.getAttribute("aria-invalid")).toBe("false");
        expect(warning.mock.calls.flat().join(" ")).not.toContain("STRICT_READ_UNTRACKED");
      } finally {
        warning.mockRestore();
        container.remove();
      }
    },
  );

  it("shows inherited defaults without turning them into stored overrides", () => {
    const { container, onPatch, text, number } = fieldFixture();
    const onRemove = vi.fn();
    text({
      schema: { type: "string", default: "balanced" },
      value: undefined,
      path: ["mode"],
      onRemove,
    });
    const textInput = query<HTMLInputElement>(container, "input[type='text']");
    expect(textInput).toMatchObject({ value: "", placeholder: "Default: balanced" });
    expect(container.textContent).not.toContain("Using default:");
    expect(onPatch).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();
    number({
      schema: { type: "integer", default: 3 },
      value: undefined,
      path: ["retries"],
      onRemove,
    });
    const numberInput = query<HTMLInputElement>(container, "input[type='number']");
    expect(numberInput).toMatchObject({ value: "", placeholder: "Default: 3" });
    expect(container.textContent).not.toContain("Using default:");
    const arrowUp = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    numberInput.dispatchEvent(arrowUp);
    expect(arrowUp.defaultPrevented).toBe(true);
    expect(onPatch).toHaveBeenLastCalledWith(["retries"], 4);
  });

  it("restores scalar and select defaults through clearing and default selection", () => {
    const { container, onPatch, number, selectField } = fieldFixture();
    const onRemove = vi.fn();
    number({
      schema: { type: "integer", default: 3, description: "Controls retry attempts." },
      value: 9,
      path: ["retries"],
      onRemove,
    });
    expect(container.textContent).toContain("Default: 3");
    expect(container.textContent).toContain("Controls retry attempts. Default: 3");
    const numberInput = query<HTMLInputElement>(container, "input[type='number']");
    edit(numberInput, "");
    expect(onPatch).toHaveBeenCalledWith(["retries"], undefined);
    expect(onRemove).not.toHaveBeenCalled();
    onPatch.mockClear();
    const selectOptions = {
      schema: { type: "string", default: "balanced" },
      path: ["mode"],
      options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
      onRemove,
    };
    selectField({ ...selectOptions, value: "fast" });
    const select = query<HTMLSelectElement>(container, "select");
    expect(container.textContent).toContain("Default: balanced");
    expect(select.options[0]?.textContent?.trim()).toBe("Default: balanced");
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("fast");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith(["mode"]);
    expect(onPatch).not.toHaveBeenCalled();
    selectField({ ...selectOptions, value: undefined });
    expect(
      query<HTMLSelectElement>(container, "select").selectedOptions[0]?.textContent?.trim(),
    ).toBe("Default: balanced");
  });

  it("does not commit a clear while a number input holds partial numeric text", () => {
    // jsdom cannot produce the browser's partial-number tuple (empty value + badInput).
    const { container, onPatch, number } = fieldFixture();
    number({ schema: { type: "number" }, value: 0, path: ["sampleRate"] });
    const input = query<HTMLInputElement>(container, "input[type='number']");
    Object.defineProperty(input, "validity", {
      value: { badInput: true },
      configurable: true,
    });
    Object.defineProperty(input, "value", {
      value: "",
      configurable: true,
      writable: true,
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    // A genuine clear (no badInput) still removes the optional override.
    Object.defineProperty(input, "validity", {
      value: { badInput: false },
      configurable: true,
    });
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["sampleRate"], undefined);
  });

  it.each([
    ["unsafe integer", { type: "integer" }, "9007199254740993"],
    ["lossy decimal", { type: "number" }, "1.0000000000000001"],
    ["underflow", { type: "number" }, "1e-324"],
  ])("rejects %s text before a pure numeric input can round it", (_name, schema, raw) => {
    const { container, onPatch, number } = fieldFixture();
    number({ schema, value: 0, path: ["numeric"] });
    const input = query<HTMLInputElement>(container, "input[type='number']");
    edit(input, raw);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe(raw);
  });

  it.each(["mixed", "number"] as const)(
    "renders an exact large integer as parser-valid text in a %s input",
    (kind) => {
      const { container, onPatch, text, number } = fieldFixture();
      const exactValue = Number("1000000000000000128");
      const params = { value: exactValue, path: ["numeric"] };
      if (kind === "mixed") {
        text({
          ...params,
          schema: { anyOf: [{ type: "string" }, { type: "number" }] },
        });
      } else {
        number({ ...params, schema: { type: "integer" } });
      }
      const input = query<HTMLInputElement>(
        container,
        `input[type='${kind === "mixed" ? "text" : "number"}']`,
      );
      expect(input.value).toBe("1000000000000000128");
      input.dispatchEvent(new Event("input", { bubbles: true }));
      expect(onPatch).toHaveBeenCalledWith(["numeric"], exactValue);
      expect(input.getAttribute("aria-invalid")).toBe("false");
    },
  );

  it("conceals the default description while a sensitive value is concealed", () => {
    const { container, text } = fieldFixture();
    text({
      schema: { type: "string", default: "inherited" },
      value: "stored-secret",
      path: ["secret"],
      hints: { secret: { sensitive: true } },
      revealSensitive: false,
      onRemove: vi.fn(),
    });
    expect(container.textContent).not.toContain("inherited");
  });

  it.each([false, true])(
    "keeps a server-redacted sentinel readonly (maskSensitive=%s)",
    (maskSensitive) => {
      const { container, text } = fieldFixture();
      text({
        schema: { type: "string" },
        value: "__OPENCLAW_REDACTED__",
        path: ["secret"],
        hints: { secret: { sensitive: true } },
        // Even with reveal forced on, the sentinel is not the stored value;
        // showing it editable would let a stray edit overwrite the credential.
        revealSensitive: !maskSensitive,
        maskSensitive,
        onToggleSensitivePath: vi.fn(),
        onRemove: vi.fn(),
      });
      const input = query<HTMLInputElement>(container, "input");
      expect(input.value).not.toContain("__OPENCLAW_REDACTED__");
      expect(input.readOnly).toBe(true);
      if (maskSensitive) {
        expect(input.placeholder).toBe("••••••••");
      }
      const eye = query<HTMLButtonElement>(container, ".settings-secret__toggle");
      expect(eye.disabled).toBe(true);
      expect(eye.getAttribute("aria-label")).toBe("This editor cannot reveal the stored value.");
    },
  );

  it("keeps an env placeholder readable in a masked sensitive field", () => {
    const { container, text } = fieldFixture();
    text({
      schema: { type: "string" },
      value: "${SLACK_BOT_TOKEN}",
      path: ["botToken"],
      hints: { botToken: { sensitive: true } },
      maskSensitive: true,
      onRemove: vi.fn(),
    });
    const input = query<HTMLInputElement>(container, "input");
    expect(input).toMatchObject({ type: "text", value: "${SLACK_BOT_TOKEN}", readOnly: false });
  });

  it.each<[string, JsonSchema[], unknown]>([
    ["object literal", [{ type: "string" }, { const: { enabled: true } }], { enabled: true }],
    ["explicit null branch", [{ type: "string" }, { const: false }, { type: "null" }], null],
    ["nullable string branch", [{ type: ["string", "null"] }, { const: false }], null],
  ])("keeps %s sentinels outside text editing", (_name, variants, value) => {
    const schema = objectSchema({ policy: { anyOf: variants } });
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).toEqual(["policy"]);
    expect(analysis.schema?.properties?.policy).toMatchObject({ anyOf: variants });
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderAnalyzedFormFixture(container, analysis, {
      value: { policy: value },
      onPatch,
    });
    expect(container.textContent).toContain("Unsupported schema node. Use Raw mode.");
    expect(container.querySelector("input, select, textarea")).toBeNull();
    expect(onPatch).not.toHaveBeenCalled();
  });
});

const containers: HTMLElement[] = [];
afterEach(() => containers.splice(0).forEach((container) => container.remove()));

function fixture(
  options: unknown[],
  initial: unknown,
  accept = true,
  field: { default?: unknown; required?: boolean } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const mode: JsonSchema = { title: "Typed mode", enum: options };
  if (field.default !== undefined) {
    mode.default = field.default;
  }
  const analysis = analyzeConfigSchema(
    objectSchema({
      settings: { ...objectSchema({ mode }), required: field.required ? ["mode"] : [] },
    }),
  );
  expect(analysis.unsupportedPaths).toEqual([]);
  let current = initial;
  const onPatch = vi.fn((_path: Array<string | number>, value: unknown) => {
    if (!accept) {
      return false;
    }
    current = value;
    draw();
    return true;
  });
  function draw() {
    renderAnalyzedFormFixture(container, analysis, {
      value: { settings: current === undefined ? {} : { mode: current } },
      onPatch,
    });
  }
  draw();
  const control = container.querySelector<HTMLElement>('[role="radiogroup"], select');
  if (!control) {
    throw new Error("Missing analyzed enum control");
  }
  return {
    container,
    control,
    onPatch,
    value() {
      return control instanceof HTMLSelectElement
        ? control.value
        : control.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value;
    },
    setValue(value: unknown) {
      current = value;
      draw();
    },
    async select(index: number | string) {
      const { userEvent } = await import("vitest/browser");
      if (control instanceof HTMLSelectElement) {
        await userEvent.selectOptions(
          control,
          query<HTMLOptionElement>(control, `option[value="${index}"]`),
        );
      } else {
        await userEvent.click(
          query<HTMLInputElement>(control, `input[type="radio"][value="${index}"]`),
        );
      }
    },
  };
}

const cases = [
  { name: "boolean/string segmented", options: [true, false, "true"] },
  { name: "number/string segmented", options: [1, 2, "1"] },
  { name: "boolean/string dropdown", options: [true, false, "true", "false", "auto", "off"] },
  { name: "number/string dropdown", options: [1, 2, "1", "2", 3, "3"] },
].map(({ name, options }) => ({ name, options, typed: options[2], primitive: options[0] }));

describe("typed config enum selection through analyzed forms", () => {
  it.each(
    cases.flatMap((entry) =>
      ["callbacks", "rejected", "default"].map((mode) => Object.assign({ mode }, entry)),
    ),
  )("preserves $name selection through $mode", async ({ options, typed, primitive, mode }) => {
    const rejected = mode === "rejected";
    const defaulted = mode === "default";
    const view = fixture(
      options,
      defaulted ? undefined : rejected ? typed : primitive,
      !rejected,
      defaulted ? { default: typed } : {},
    );
    if (defaulted) {
      expect(view.value()).toBe(options.length <= 5 ? "2" : "__unset__");
      expect(view.onPatch).not.toHaveBeenCalled();
    } else if (!rejected) {
      expect(view.value()).toBe("0");
      await view.select(2);
      expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], typed);
      expect(view.value()).toBe("2");
    }
    await view.select(0);
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], primitive);
    expect(view.value()).toBe(rejected ? "2" : "0");
    if (!rejected && !defaulted) {
      view.setValue(typed);
      expect(view.value()).toBe("2");
    }
  });

  it("keeps null, unset and a typed string distinct in a nullable enum", async () => {
    const view = fixture([true, false, "true", null], null);
    expect(view.value()).toBe("__null__");
    await view.select(2);
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], "true");
    expect(view.value()).toBe("2");
    await view.select("__unset__");
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], undefined);
    expect(view.value()).toBe("__unset__");
    await view.select("__null__");
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], null);
    expect(view.value()).toBe("__null__");
  });

  it("keeps required nullable enums from clearing an explicit typed member", async () => {
    const view = fixture([true, false, "true", null], "true", true, { required: true });
    expect(view.value()).toBe("2");
    expect(
      view.control.querySelector<HTMLOptionElement>('option[value="__unset__"]')?.disabled,
    ).toBe(true);
    await view.select("__null__");
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], null);
  });
});
