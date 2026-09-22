// Control UI tests cover scalar identity and nullable enum behavior.
import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  renderNumberInputFixture,
  renderTextInputFixture,
  renderSelectFixture,
  renderAnalyzedFormFixture,
} from "../test-helpers/config-form-fixtures.ts";
import { renderNumberInput, renderTextInput } from "./config-form.node.scalar.ts";
import { analyzeConfigSchema, type JsonSchema } from "./config-form.ts";

function expectElement<T extends Element>(element: T | null | undefined, label: string): T {
  expect(element instanceof Element, label).toBe(true);
  if (!(element instanceof Element)) {
    throw new Error(`missing ${label}`);
  }
  return element;
}

describe("config form scalar integrity", () => {
  it("keeps repeated number input identity arguments aligned", () => {
    const container = document.createElement("div");
    const renderValue = (controlIdentity: number[]) => {
      renderNumberInputFixture(container, {
        schema: { type: "integer" },
        value: 2,
        path: ["values", 0],
        sourceIdentity: 2,
        controlIdentity,
        onPatch: vi.fn(),
      });
    };

    renderValue([2]);
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "repeated number input",
    );
    renderValue([2, 4]);
    expect(container.querySelector("input[type='number']")).toBe(input);
    expect(input.value).toBe("2");
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it("keeps a focused in-flight edit through a snapshot identity refresh", () => {
    const container = document.createElement("div");
    document.body.append(container);
    const renderValue = (value: string, sourceIdentity: unknown) => {
      renderTextInputFixture(container, {
        schema: { type: "string" },
        value,
        path: ["laboratory", "endpoint"],
        sourceIdentity,
        inputType: "text",
        onPatch: vi.fn(),
      });
    };
    try {
      renderValue("local-api", { snapshot: 1 });
      const input = expectElement(
        container.querySelector<HTMLInputElement>("input[type='text']"),
        "endpoint input",
      );

      // Mid-typing window: the DOM holds text the model has not committed yet
      // (no input event dispatched). A background config refresh that only
      // changes the snapshot identity must not eat it while the field is
      // focused.
      input.focus();
      input.value = "form-api";
      renderValue("local-api", { snapshot: 2 });
      expect(input.value).toBe("form-api");

      // The blurred authoritative-reset contract stays intact.
      input.blur();
      renderValue("remote-api", { snapshot: 3 });
      expect(input.value).toBe("remote-api");
    } finally {
      container.remove();
    }
  });

  it("allows required nullable enums to select their null member", () => {
    const container = document.createElement("div");
    const nullablePatch = vi.fn();
    renderSelectFixture(container, {
      schema: {
        type: "string",
        nullable: true,
        enumIncludesNull: true,
      },
      value: "fixed",
      path: ["nullableMode"],
      isRequired: true,
      options: ["fixed", "other"],
      onPatch: nullablePatch,
    });
    const nullableSelect = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "required nullable enum",
    );
    const nullOption = expectElement(
      nullableSelect.querySelector<HTMLOptionElement>("option[value='__null__']"),
      "nullable enum null option",
    );
    expect(nullOption.disabled).toBe(false);
    expect(
      nullableSelect.querySelector<HTMLOptionElement>("option[value='__unset__']")?.disabled,
    ).toBe(true);
    nullableSelect.value = "__null__";
    nullableSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(nullablePatch).toHaveBeenCalledWith(["nullableMode"], null);

    const requiredPatch = vi.fn();
    renderSelectFixture(container, {
      schema: { type: "string" },
      value: "fixed",
      path: ["requiredMode"],
      isRequired: true,
      options: ["fixed", "other"],
      onPatch: requiredPatch,
    });
    const requiredSelect = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "required non-null enum",
    );
    expect(
      requiredSelect.querySelector<HTMLOptionElement>("option[value='__unset__']")?.disabled,
    ).toBe(true);
    requiredSelect.value = "__unset__";
    requiredSelect.dispatchEvent(new Event("change", { bubbles: true }));
    expect(requiredSelect.value).toBe("0");
    expect(requiredPatch).not.toHaveBeenCalled();
  });

  it("keeps optional nullable enum unset distinct from explicit null", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const renderValue = (value: unknown) => {
      renderSelectFixture(container, {
        schema: {
          type: "string",
          nullable: true,
          enumIncludesNull: true,
        },
        value,
        path: ["mode"],
        options: ["fixed", "other"],
        onPatch,
      });
    };

    renderValue(null);
    const select = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "optional nullable enum",
    );
    expect(select.value).toBe("__null__");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], undefined);

    renderValue("fixed");
    select.value = "__null__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], null);
  });

  it("shows inherited defaults without turning them into stored overrides", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();

    renderTextInputFixture(container, {
      schema: { type: "string", default: "balanced" },
      value: undefined,
      path: ["mode"],
      inputType: "text",
      onPatch,
      onRemove,
    });

    const textInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='text']"),
      "defaulted text input",
    );
    expect(textInput.value).toBe("");
    expect(textInput.placeholder).toBe("Default: balanced");
    expect(container.textContent).toContain("Using default: balanced");
    expect(onPatch).not.toHaveBeenCalled();
    expect(onRemove).not.toHaveBeenCalled();

    renderNumberInputFixture(container, {
      schema: { type: "integer", default: 3 },
      value: undefined,
      path: ["retries"],
      onPatch,
      onRemove,
    });
    const numberInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "defaulted number input",
    );
    expect(numberInput.value).toBe("");
    expect(numberInput.placeholder).toBe("Default: 3");
    expect(container.textContent).toContain("Using default: 3");

    const arrowUp = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "ArrowUp",
    });
    numberInput.dispatchEvent(arrowUp);
    expect(arrowUp.defaultPrevented).toBe(true);
    expect(onPatch).toHaveBeenLastCalledWith(["retries"], 4);
  });

  it("shows the default description without a reset button on an overridden row", () => {
    const container = document.createElement("div");
    renderTextInputFixture(container, {
      schema: { type: "string", default: "balanced" },
      value: "custom",
      path: ["mode"],
      inputType: "text",
      onPatch: vi.fn(),
    });

    expect(container.textContent).toContain("Default: balanced");
    expect(container.querySelector("button[aria-label='Reset to default']")).toBeNull();
  });

  it("restores scalar and select defaults through clearing and default selection", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const onRemove = vi.fn();

    renderNumberInputFixture(container, {
      schema: { type: "integer", default: 3 },
      value: 9,
      path: ["retries"],
      onPatch,
      onRemove,
    });
    expect(container.textContent).toContain("Default: 3");
    const numberInput = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "number input",
    );
    numberInput.value = "";
    numberInput.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenCalledWith(["retries"], undefined);
    expect(onRemove).not.toHaveBeenCalled();

    onPatch.mockClear();
    renderSelectFixture(container, {
      schema: { type: "string", default: "balanced" },
      value: "fast",
      path: ["mode"],
      options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
      onPatch,
      onRemove,
    });
    const select = expectElement(
      container.querySelector<HTMLSelectElement>("select"),
      "default-aware select",
    );
    expect(container.textContent).toContain("Default: balanced");
    expect(select.options[0]?.textContent?.trim()).toBe("Default: balanced");
    expect(select.selectedOptions[0]?.textContent?.trim()).toBe("fast");
    select.value = "__unset__";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(onRemove).toHaveBeenCalledWith(["mode"]);
    expect(onPatch).not.toHaveBeenCalled();

    renderSelectFixture(container, {
      schema: { type: "string", default: "balanced" },
      value: undefined,
      path: ["mode"],
      options: ["balanced", "fast", "careful", "safe", "strict", "custom"],
      onPatch,
      onRemove,
    });
    expect(
      expectElement(
        container.querySelector<HTMLSelectElement>("select"),
        "inherited select",
      ).selectedOptions[0]?.textContent?.trim(),
    ).toBe("Default: balanced");
  });

  it("commits the valid branch type for constrained text unions", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderTextInputFixture(container, {
      schema: {
        anyOf: [
          { type: "string", const: "auto" },
          { type: "integer", minimum: 0 },
        ],
      },
      value: "auto",
      path: ["mode"],
      inputType: "text",
      onPatch,
    });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='text']"),
      "constrained union input",
    );

    input.value = "42";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], 42);
    expect(input.getAttribute("aria-invalid")).toBe("false");

    input.value = "auto";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["mode"], "auto");

    onPatch.mockClear();
    input.value = "invalid";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("commits explicit boolean branches without retyping numeric strings", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderTextInputFixture(container, {
      schema: {
        anyOf: [{ type: "string" }, { type: "number" }, { const: false }],
      },
      value: "500mb",
      path: ["maxDiskBytes"],
      inputType: "text",
      onPatch,
    });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='text']"),
      "string-number-boolean union input",
    );

    input.value = "false";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["maxDiskBytes"], false);

    input.value = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["maxDiskBytes"], "true");

    const identifier = "1048113311314608148";
    input.value = identifier;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["maxDiskBytes"], identifier);
  });

  it("does not commit a clear while a number input holds partial numeric text", () => {
    // Browsers report value === "" with validity.badInput while the user is
    // mid-keystroke ("0." on the way to "0.5"). Committing undefined here
    // deleted the stored value and wiped the input. jsdom never sets
    // badInput, so simulate the browser tuple explicitly.
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderNumberInputFixture(container, {
      schema: { type: "number" },
      value: 0,
      path: ["sampleRate"],
      onPatch,
    });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "partial numeric input",
    );
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
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderNumberInputFixture(container, {
      schema,
      value: 0,
      path: ["numeric"],
      onPatch,
    });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "lossless number input",
    );

    input.value = raw;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));

    expect(onPatch).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.value).toBe(raw);
  });

  it("accepts an exactly represented integer above the safe-integer range", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderNumberInputFixture(container, {
      schema: { type: "integer" },
      value: 0,
      path: ["numeric"],
      onPatch,
    });
    const input = expectElement(
      container.querySelector<HTMLInputElement>("input[type='number']"),
      "exact large number input",
    );

    input.value = "9007199254740992";
    input.dispatchEvent(new Event("input", { bubbles: true }));

    expect(onPatch).toHaveBeenCalledWith(["numeric"], 9_007_199_254_740_992);
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  it.each(["mixed", "number"] as const)(
    "renders an exact large integer as parser-valid text in a %s input",
    (kind) => {
      const container = document.createElement("div");
      const onPatch = vi.fn();
      const exactValue = Number("1000000000000000128");
      const params = {
        value: exactValue,
        path: ["numeric"],
        hints: {},
        unsupported: new Set<string>(),
        disabled: false,
        onPatch,
      };
      render(
        kind === "mixed"
          ? renderTextInput({
              ...params,
              schema: { anyOf: [{ type: "string" }, { type: "number" }] },
              inputType: "text",
            })
          : renderNumberInput({ ...params, schema: { type: "integer" } }),
        container,
      );
      const input = expectElement(
        container.querySelector<HTMLInputElement>(
          `input[type='${kind === "mixed" ? "text" : "number"}']`,
        ),
        `${kind} exact large number input`,
      );

      expect(input.value).toBe("1000000000000000128");
      input.dispatchEvent(new Event("input", { bubbles: true }));

      expect(onPatch).toHaveBeenCalledWith(["numeric"], exactValue);
      expect(input.getAttribute("aria-invalid")).toBe("false");
    },
  );

  it("conceals the default description while a sensitive value is concealed", () => {
    const container = document.createElement("div");

    renderTextInputFixture(container, {
      schema: { type: "string", default: "inherited" },
      value: "stored-secret",
      path: ["secret"],
      hints: { secret: { sensitive: true } },
      inputType: "text",
      revealSensitive: false,
      onPatch: vi.fn(),
      onRemove: vi.fn(),
    });

    expect(container.textContent).not.toContain("inherited");
  });

  it("never reveals a server-redacted sentinel and keeps the input readonly", () => {
    const container = document.createElement("div");

    renderTextInputFixture(container, {
      schema: { type: "string" },
      value: "__OPENCLAW_REDACTED__",
      path: ["secret"],
      hints: { secret: { sensitive: true } },
      inputType: "text",
      // Even with reveal forced on, the sentinel is not the stored value;
      // showing it editable would let a stray edit overwrite the credential.
      revealSensitive: true,
      onToggleSensitivePath: vi.fn(),
      onPatch: vi.fn(),
      onRemove: vi.fn(),
    });

    const input = expectElement(
      container.querySelector<HTMLInputElement>("input"),
      "sentinel secret input",
    );
    expect(input.value).not.toContain("__OPENCLAW_REDACTED__");
    expect(input.readOnly).toBe(true);
    const eye = expectElement(
      container.querySelector<HTMLButtonElement>(".settings-secret__toggle"),
      "stored secret reveal toggle",
    );
    expect(eye.disabled).toBe(true);
    expect(eye.getAttribute("aria-label")).toBe(
      "Stored secrets are never sent to the browser; enter a new value to replace it",
    );
  });

  it("preserves string and false edits through the analyzer path", () => {
    const container = document.createElement("div");
    const onPatch = vi.fn();
    const schema = {
      type: "object",
      properties: {
        sessionRetention: {
          anyOf: [{ type: "string" }, { type: "boolean", const: false }],
        },
      },
    };
    const analysis = analyzeConfigSchema(schema);
    expect(analysis.unsupportedPaths).not.toContain("sessionRetention");

    const renderValue = (value: string | boolean) => {
      renderAnalyzedFormFixture(container, analysis, {
        value: { sessionRetention: value },
        onPatch,
      });
      return expectElement(
        container.querySelector<HTMLInputElement>("input"),
        "string-or-false union input",
      );
    };

    let input = renderValue("7d");
    expect(input.value).toBe("7d");
    input.value = "false";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["sessionRetention"], false);

    input = renderValue(false);
    expect(input.value).toBe("false");
    input.value = "30d";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onPatch).toHaveBeenLastCalledWith(["sessionRetention"], "30d");
  });

  it.each([
    { name: "numeric literal", variants: [{ type: "string" }, { const: 5 }], value: 5 },
    {
      name: "typed numeric literal",
      variants: [{ type: "string" }, { type: "number", const: 5 }],
      value: 5,
    },
    {
      name: "object literal",
      variants: [{ type: "string" }, { const: { enabled: true } }],
      value: { enabled: true },
    },
    { name: "array literal", variants: [{ type: "string" }, { const: ["auto"] }], value: ["auto"] },
    {
      name: "explicit null branch",
      variants: [{ type: "string" }, { const: false }, { type: "null" }],
      value: null,
    },
    {
      name: "nullable string branch",
      variants: [{ type: ["string", "null"] }, { const: false }],
      value: null,
    },
  ] satisfies Array<{ name: string; variants: JsonSchema[]; value: unknown }>)(
    "keeps $name sentinels outside text editing",
    ({ variants, value }) => {
      const schema: JsonSchema = {
        type: "object",
        properties: { policy: { anyOf: variants } },
      };
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
    },
  );
});

type EnumControl = HTMLElement & { value: string; updateComplete?: Promise<unknown> };
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
  const analysis = analyzeConfigSchema({
    type: "object",
    properties: {
      settings: {
        type: "object",
        required: field.required ? ["mode"] : [],
        properties: {
          mode: {
            title: "Typed mode",
            enum: options,
            ...(field.default !== undefined ? { default: field.default } : {}),
          },
        },
      },
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
  const control = container.querySelector<EnumControl>("wa-radio-group, select");
  if (!control) {
    throw new Error("Missing analyzed enum control");
  }
  return {
    container,
    control,
    onPatch,
    async settle() {
      await control.updateComplete;
    },
    async setValue(value: unknown) {
      current = value;
      draw();
      await control.updateComplete;
    },
    async select(index: number | string) {
      const { userEvent } = await import("vitest/browser");
      if (control instanceof HTMLSelectElement) {
        const option = control.querySelector<HTMLOptionElement>(`option[value="${index}"]`);
        if (!option) {
          throw new Error("Missing enum option");
        }
        await userEvent.selectOptions(control, option);
      } else {
        const radio = control.querySelector<HTMLElement>(`wa-radio[value="${index}"]`);
        if (!radio) {
          throw new Error("Missing enum radio");
        }
        await userEvent.click(radio);
        await control.updateComplete;
      }
    },
  };
}

const cases = [
  {
    name: "boolean/string segmented",
    options: [true, false, "true"],
    typed: "true",
    primitive: true,
  },
  { name: "number/string segmented", options: [1, 2, "1"], typed: "1", primitive: 1 },
  {
    name: "boolean/string dropdown",
    options: [true, false, "true", "false", "auto", "off"],
    typed: "true",
    primitive: true,
  },
  { name: "number/string dropdown", options: [1, 2, "1", "2", 3, "3"], typed: "1", primitive: 1 },
];

describe("typed config enum selection through analyzed forms", () => {
  it.each(cases)("initially selects the typed member: $name", async ({ options, typed }) => {
    const view = fixture(options, typed);
    await view.settle();
    expect(view.control.tagName).toBe(options.length <= 5 ? "WA-RADIO-GROUP" : "SELECT");
    expect(view.control.value).toBe("2");
    expect(view.onPatch).not.toHaveBeenCalled();
  });

  it.each(cases)(
    "preserves type through callbacks and rerenders: $name",
    async ({ options, typed, primitive }) => {
      const view = fixture(options, primitive);
      await view.settle();
      expect(view.control.value).toBe("0");
      await view.select(2);
      expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], typed);
      expect(view.control.value).toBe("2");
      await view.select(0);
      expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], primitive);
      expect(view.control.value).toBe("0");
      await view.setValue(typed);
      expect(view.control.value).toBe("2");
    },
  );

  it.each(cases)(
    "restores the typed member after a rejected selection: $name",
    async ({ options, typed }) => {
      const view = fixture(options, typed, false);
      await view.settle();
      await view.select(0);
      expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], options[0]);
      expect(view.control.value).toBe("2");
    },
  );

  it.each(cases)(
    "keeps the typed default without creating an override: $name",
    async ({ options, typed, primitive }) => {
      const view = fixture(options, undefined, true, { default: typed });
      await view.settle();
      expect(view.control.value).toBe(options.length <= 5 ? "2" : "__unset__");
      expect(view.onPatch).not.toHaveBeenCalled();
      await view.select(0);
      expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], primitive);
      expect(view.control.value).toBe("0");
    },
  );

  it("keeps null, unset and a typed string distinct in a nullable enum", async () => {
    const view = fixture([true, false, "true", null], null);
    await view.settle();
    expect(view.control.value).toBe("__null__");
    await view.select(2);
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], "true");
    expect(view.control.value).toBe("2");
    await view.select("__unset__");
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], undefined);
    expect(view.control.value).toBe("__unset__");
    await view.select("__null__");
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], null);
    expect(view.control.value).toBe("__null__");
  });

  it("keeps required nullable enums from clearing an explicit typed member", async () => {
    const view = fixture([true, false, "true", null], "true", true, { required: true });
    await view.settle();
    expect(view.control.value).toBe("2");
    expect(
      view.control.querySelector<HTMLOptionElement>('option[value="__unset__"]')?.disabled,
    ).toBe(true);
    await view.select("__null__");
    expect(view.onPatch).toHaveBeenLastCalledWith(["settings", "mode"], null);
  });
});
