// Control UI tests cover scalar identity and nullable enum behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  expectElement,
  renderNumberInputFixture,
  renderTextInputFixture,
  renderSelectFixture,
  renderAnalyzedFormFixture,
} from "../test-helpers/config-form-fixtures.tsx";
import { analyzeConfigSchema } from "./config-form.analyze.ts";
import type { JsonSchema } from "./config-form.shared.ts";

function analyze(properties: Record<string, JsonSchema>) {
  return analyzeConfigSchema({ type: "object", properties });
}
function edit(
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  event = "input",
) {
  control.value = value;
  control.dispatchEvent(new Event(event, { bubbles: true }));
}

describe("config form scalar integrity", () => {
  let container: HTMLDivElement;
  let onPatch: ReturnType<typeof vi.fn>;
  let onRemove: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    container = document.createElement("div");
    onPatch = vi.fn();
    onRemove = vi.fn();
  });
  function field<T extends Element>(selector: string) {
    return expectElement(container.querySelector<T>(selector), selector);
  }
  function renderText<T extends Element = HTMLInputElement>(
    options: Omit<Parameters<typeof renderTextInputFixture>[1], "onPatch" | "inputType"> & {
      inputType?: "text" | "number";
    },
  ) {
    renderTextInputFixture(container, { onPatch, inputType: "text", ...options });
    return field<T>("input, textarea");
  }
  function renderNumber(options: Omit<Parameters<typeof renderNumberInputFixture>[1], "onPatch">) {
    renderNumberInputFixture(container, { onPatch, ...options });
    return field<HTMLInputElement>("input[type='number']");
  }
  function renderSelect(options: Omit<Parameters<typeof renderSelectFixture>[1], "onPatch">) {
    renderSelectFixture(container, { onPatch, ...options });
    return field<HTMLSelectElement>("select");
  }
  function secret(value: string, options: Partial<Parameters<typeof renderText>[0]> = {}) {
    return renderText({
      schema: { type: "string" },
      path: ["secret"],
      hints: { secret: { sensitive: true } },
      value,
      ...options,
    });
  }
  it.each([false, true])("edits multiline string hints with commitOnBlur=%s", (commitOnBlur) => {
    const path = ["reviewInstructions"];
    const placeholder = "Default guidance.\nSecond line.";
    const textarea = renderText<HTMLTextAreaElement>({
      schema: { type: "string", maxLength: 4000 },
      value: undefined,
      path,
      hints: { reviewInstructions: { label: "Review instructions", multiline: true, placeholder } },
      commitOnBlur,
    });
    expect(textarea.getAttribute("aria-label")).toBe("Review instructions");
    expect(textarea.placeholder).toBe(placeholder);
    expect(textarea.value).toBe("");
    expect(onPatch).not.toHaveBeenCalled();
    edit(textarea, "Look for scope drift.\nPreserve required checks.");
    if (commitOnBlur) {
      expect(onPatch).not.toHaveBeenCalled();
      textarea.dispatchEvent(new FocusEvent("blur"));
    }
    expect(onPatch).toHaveBeenLastCalledWith(path, textarea.value);
    edit(textarea, "x".repeat(4001));
    textarea.dispatchEvent(new Event("change", { bubbles: true }));
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(onPatch).toHaveBeenCalledTimes(1);
  });

  it("separates boolean help from its default description", () => {
    const analysis = analyze({
      runtime: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true, description: "Controls runtime processing." },
        },
      },
    });
    renderAnalyzedFormFixture(container, analysis, {
      value: { runtime: { enabled: false } },
      onPatch,
    });
    expect(container.textContent).toContain("Controls runtime processing. Default: true");
  });

  it.each(["text", "number"] as const)(
    "revalidates a focused %s draft through snapshot refresh without untracked reads",
    (inputType) => {
      const warning = vi.spyOn(console, "warn");
      document.body.append(container);
      const schema: JsonSchema =
        inputType === "text" ? { type: "string", minLength: 3 } : { type: "integer", minimum: 1 };
      const value = inputType === "text" ? "local-api" : 8080;
      const draft = inputType === "text" ? "x" : "0";
      const refreshedValue = inputType === "text" ? "remote-api" : 9000;
      const renderValue = (current: string | number, sourceIdentity: unknown) => {
        renderText({
          schema,
          value: current,
          path: ["laboratory", "endpoint"],
          sourceIdentity,
          inputType,
        });
      };
      try {
        renderValue(value, { snapshot: 1 });
        const input = field<HTMLInputElement>("input");
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

  it.each([
    ["text", { type: "string", default: "balanced" }],
    ["number", { type: "integer", default: 3 }],
  ] satisfies Array<[string, JsonSchema]>)(
    "keeps %s defaults inherited until edited",
    (kind, schema) => {
      const options = { schema, value: undefined, path: ["setting"], onRemove };
      const input = kind === "number" ? renderNumber(options) : renderText(options);
      expect(input).toMatchObject({ value: "", placeholder: `Default: ${schema.default}` });
      expect(container.textContent).not.toContain("Using default:");
      expect(onPatch).not.toHaveBeenCalled();
      expect(onRemove).not.toHaveBeenCalled();
      if (kind === "number") {
        const up = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "ArrowUp",
        });
        input.dispatchEvent(up);
        expect(up.defaultPrevented).toBe(true);
        expect(onPatch).toHaveBeenLastCalledWith(["setting"], 4);
        const overridden = renderNumber({
          ...options,
          value: 9,
          schema: { ...schema, description: "Controls retry attempts." },
        });
        expect(container.textContent).toContain("Controls retry attempts. Default: 3");
        edit(overridden, "");
        expect(onPatch).toHaveBeenLastCalledWith(["setting"], undefined);
        expect(onRemove).not.toHaveBeenCalled();
      }
    },
  );

  it("clears a select override and displays its inherited default", () => {
    const options = {
      schema: { type: "string", default: "balanced" },
      path: ["mode"],
      options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
      onRemove,
    };
    const select = renderSelect({ ...options, value: "fast" });
    expect(container.textContent).toContain("Default: balanced");
    expect(select.options[0]?.textContent?.trim()).toBe("Default: balanced");
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("fast");
    edit(select, "__unset__", "change");
    expect(onRemove).toHaveBeenCalledWith(["mode"]);
    expect(onPatch).not.toHaveBeenCalled();
    const inherited = renderSelect({ ...options, value: undefined });
    expect(inherited.selectedOptions[0]?.textContent?.trim()).toBe("Default: balanced");
  });

  it("does not commit a clear while a number input holds partial numeric text", () => {
    // Browsers report value === "" with validity.badInput while the user is
    // mid-keystroke ("0." on the way to "0.5"). Committing undefined here
    // deleted the stored value and wiped the input. jsdom never sets
    // badInput, so simulate the browser tuple explicitly.
    renderNumber({
      schema: { type: "number" },
      value: 0,
      path: ["sampleRate"],
    });
    const input = field<HTMLInputElement>("input[type='number']");
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
    renderNumber({
      schema,
      value: 0,
      path: ["numeric"],
    });
    const input = field<HTMLInputElement>("input[type='number']");

    input.value = raw;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe(raw);
  });

  it.each(["mixed", "number"] as const)(
    "renders an exact large integer as parser-valid text in a %s input",
    (kind) => {
      const exactValue = Number("1000000000000000128");
      const params = {
        value: exactValue,
        path: ["numeric"],
      };
      if (kind === "mixed") {
        renderText({
          ...params,
          schema: { anyOf: [{ type: "string" }, { type: "number" }] },
        });
      } else {
        renderNumber({ ...params, schema: { type: "integer" } });
      }
      const input = field<HTMLInputElement>(
        `input[type='${kind === "mixed" ? "text" : "number"}']`,
      );

      expect(input.value).toBe("1000000000000000128");
      input.dispatchEvent(new Event("input", { bubbles: true }));

      expect(onPatch).toHaveBeenCalledWith(["numeric"], exactValue);
      expect(input.getAttribute("aria-invalid")).toBe("false");
    },
  );

  it("conceals the default description while a sensitive value is concealed", () => {
    secret("stored-secret", {
      schema: { type: "string", default: "inherited" },
      revealSensitive: false,
    });

    expect(container.textContent).not.toContain("inherited");
  });

  it.each([false, true])(
    "keeps a server-redacted sentinel readonly (maskSensitive=%s)",
    (maskSensitive) => {
      const input = secret("__OPENCLAW_REDACTED__", {
        // Even with reveal forced on, the sentinel is not the stored value;
        // showing it editable would let a stray edit overwrite the credential.
        revealSensitive: !maskSensitive,
        maskSensitive,
        onToggleSensitivePath: vi.fn(),
      });
      expect(input.value).not.toContain("__OPENCLAW_REDACTED__");
      expect(input.readOnly).toBe(true);
      if (maskSensitive) {
        expect(input.placeholder).toBe("••••••••");
      }
      const eye = field<HTMLButtonElement>(".settings-secret__toggle");
      expect(eye.disabled).toBe(true);
      expect(eye.getAttribute("aria-label")).toBe("This editor cannot reveal the stored value.");
    },
  );

  it("keeps an env placeholder readable in a masked sensitive field", () => {
    const input = secret("${SLACK_BOT_TOKEN}", { maskSensitive: true });
    expect(input.type).toBe("text");
    expect(input.value).toBe("${SLACK_BOT_TOKEN}");
    expect(input.readOnly).toBe(false);
  });

  it.each([
    ["object literal", [{ type: "string" }, { const: { enabled: true } }], { enabled: true }],
    ["explicit null", [{ type: "string" }, { const: false }, { type: "null" }], null],
    ["nullable string", [{ type: ["string", "null"] }, { const: false }], null],
  ] satisfies Array<[string, JsonSchema[], unknown]>)(
    "keeps %s sentinels outside text editing",
    (_name, variants, value) => {
      const analysis = analyze({ policy: { anyOf: variants } });
      expect(analysis.unsupportedPaths).toEqual(["policy"]);
      renderAnalyzedFormFixture(container, analysis, {
        value: { policy: value },
        onPatch,
      });
      expect(container.textContent).toContain("Unsupported schema node. Use Raw mode.");
      expect(container.querySelector("input, select, textarea")).toBeNull();
      expect(onPatch).not.toHaveBeenCalled();
    },
  );
});

const containers: HTMLElement[] = [];
afterEach(() => {
  for (const container of containers.splice(0)) {
    container.remove();
  }
});

function fixture(
  options: unknown[],
  initial: unknown,
  accept = true,
  field: { default?: unknown; required?: boolean } = {},
) {
  const container = document.createElement("div");
  document.body.append(container);
  containers.push(container);
  const { required, ...defaults } = field;
  const analysis = analyze({
    settings: {
      type: "object",
      required: required ? ["mode"] : [],
      properties: { mode: { enum: options, ...defaults } },
    },
  });
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
  const control = expectElement(
    container.querySelector<HTMLElement>('[role="radiogroup"], select'),
    "enum control",
  );
  const value = () =>
    control instanceof HTMLSelectElement
      ? control.value
      : control.querySelector<HTMLInputElement>('input[type="radio"]:checked')?.value;
  return {
    control,
    onPatch,
    value,
    setValue(next: unknown) {
      current = next;
      draw();
    },
    async select(index: number | string, expected: unknown, selected = index) {
      const { userEvent } = await import("vitest/browser");
      if (control instanceof HTMLSelectElement) {
        const option = expectElement(
          control.querySelector<HTMLOptionElement>(`option[value="${index}"]`),
          "enum option",
        );
        await userEvent.selectOptions(control, option);
      } else {
        const radio = expectElement(
          control.querySelector<HTMLInputElement>(`input[type="radio"][value="${index}"]`),
          "enum radio",
        );
        await userEvent.click(radio);
      }
      expect(onPatch).toHaveBeenLastCalledWith(["settings", "mode"], expected);
      expect(value()).toBe(String(selected));
    },
  };
}

const cases = [
  ["boolean/string segmented", [true, false, "true"]],
  ["number/string segmented", [1, 2, "1"]],
  ["boolean/string dropdown", [true, false, "true", "false", "auto", "off"]],
  ["number/string dropdown", [1, 2, "1", "2", 3, "3"]],
] satisfies Array<[string, Array<string | number | boolean>]>;

describe("typed config enum selection through analyzed forms", () => {
  it.each(cases)("preserves type through callbacks and rerenders: %s", async (_name, options) => {
    const view = fixture(options, options[0]);
    expect(view.value()).toBe("0");
    await view.select(2, options[2]);
    await view.select(0, options[0]);
    view.setValue(options[2]);
    expect(view.value()).toBe("2");
  });

  it.each(cases)(
    "restores the typed member after a rejected selection: %s",
    async (_name, options) => {
      const view = fixture(options, options[2], false);
      await view.select(0, options[0], 2);
    },
  );

  it.each(cases)(
    "keeps the typed default without creating an override: %s",
    async (_name, options) => {
      const view = fixture(options, undefined, true, { default: options[2] });
      expect(view.value()).toBe(options.length <= 5 ? "2" : "__unset__");
      expect(view.onPatch).not.toHaveBeenCalled();
      await view.select(0, options[0]);
    },
  );

  it("keeps null, unset and a typed string distinct in a nullable enum", async () => {
    const view = fixture([true, false, "true", null], null);
    expect(view.value()).toBe("__null__");
    await view.select(2, "true");
    await view.select("__unset__", undefined);
    await view.select("__null__", null);
  });

  it("keeps required nullable enums from clearing an explicit typed member", async () => {
    const view = fixture([true, false, "true", null], "true", true, { required: true });
    expect(view.value()).toBe("2");
    expect(
      view.control.querySelector<HTMLOptionElement>('option[value="__unset__"]')?.disabled,
    ).toBe(true);
    await view.select("__null__", null);
  });
});
