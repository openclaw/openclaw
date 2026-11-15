// Control UI tests cover replacing stored secrets, and the values that stay read-only.
import { describe, expect, it, vi } from "vitest";
import type { ConfigSecretFields } from "../lib/config/config-secret-fields.ts";
import type { StoredSecretSource } from "../lib/config/stored-secret-source.ts";
import { expectElement, renderTextInputFixture } from "../test-helpers/config-form-fixtures.tsx";
import { flush } from "../test-helpers/solid-settle.ts";
import { resolveConfigObjectFields } from "./config-form.node.collection.ts";
import type { JsonSchema } from "./config-form.shared.ts";

const REDACTED = "__OPENCLAW_REDACTED__";
const schema: JsonSchema = { type: "string" };
const path = ["channels", "telegram", "botToken"];
const hints = { "channels.telegram.botToken": { sensitive: true, label: "Bot Token" } };

const literal: StoredSecretSource = { kind: "literal" };
const reference: StoredSecretSource = { kind: "reference" };
const environment = (name: string): StoredSecretSource => ({ kind: "environment", name });

function fakeSecretFields(source: StoredSecretSource = literal) {
  const held = new Map<string, string>();
  const listeners = new Set<() => void>();
  const notify = () => listeners.forEach((listener) => listener());
  return {
    source: () => source,
    read: (target) => held.get(JSON.stringify(target)),
    hold: vi.fn((target, text) => {
      held.set(JSON.stringify(target), text);
      notify();
    }),
    release: vi.fn((target) => {
      held.delete(JSON.stringify(target));
      notify();
    }),
    save: vi.fn(async () => ({ ok: true as const })),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  } satisfies ConfigSecretFields;
}

function render(params: {
  value: unknown;
  secretFields?: ConfigSecretFields;
  replace?: boolean;
  source?: StoredSecretSource;
}) {
  const container = document.createElement("div");
  const onPatch = vi.fn();
  renderTextInputFixture(container, {
    schema,
    value: params.value,
    path,
    inputType: "text",
    hints,
    secretFields: params.secretFields,
    replaceStoredSecrets: params.replace ? { source: () => params.source ?? literal } : undefined,
    onPatch,
  });
  const input = expectElement(container.querySelector<HTMLInputElement>("input"), "secret input");
  return { input, onPatch };
}

function type(input: HTMLInputElement, text: string) {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new FocusEvent("blur"));
  flush();
}

describe("stored secrets", () => {
  it("stays read-only when nothing would own an explicit Save", () => {
    const { input } = render({ value: REDACTED });
    expect(input.readOnly).toBe(true);
  });

  it("holds a replacement without patching the shared draft", () => {
    const secretFields = fakeSecretFields();
    const { input, onPatch } = render({ value: REDACTED, secretFields });
    expect(input).toMatchObject({
      readOnly: false,
      value: "",
      type: "password",
      placeholder: "••••••••",
    });
    type(input, "new-token");
    expect(secretFields.hold).toHaveBeenCalledWith(path, "new-token", expect.anything());
    expect(onPatch).not.toHaveBeenCalled();
    type(input, "");
    expect(secretFields.release).toHaveBeenCalledWith(path);
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("holds a redacted value the schema didn't mark", () => {
    const secretFields = fakeSecretFields();
    const container = document.createElement("div");
    const onPatch = vi.fn();
    renderTextInputFixture(container, {
      schema,
      value: REDACTED,
      path: ["other", "credential"],
      inputType: "text",
      hints: {},
      secretFields,
      onPatch,
    });
    const input = expectElement(container.querySelector<HTMLInputElement>("input"), "input");
    expect(input.readOnly).toBe(false);
    type(input, "new-token");
    expect(onPatch).not.toHaveBeenCalled();
  });

  it("lets a form with its own Save take the replacement as an edit", () => {
    const { input, onPatch } = render({ value: REDACTED, replace: true });
    expect(input.readOnly).toBe(false);
    type(input, "new-token");
    expect(onPatch).toHaveBeenCalledWith(path, "new-token");
  });

  it("keeps a SecretRef read-only and says why", () => {
    const secretFields = fakeSecretFields();
    const { input } = render({
      value: { source: "env", provider: "default", id: REDACTED },
      secretFields,
      replace: true,
    });
    expect(input.readOnly).toBe(true);
    expect(input.placeholder).toContain("SecretRef");
    type(input, "new-token");
    expect(secretFields.hold).not.toHaveBeenCalled();
  });

  it("keeps the parts of a SecretRef out of the replace flow", () => {
    const secretFields = fakeSecretFields();
    const { fields } = resolveConfigObjectFields({
      schema: {
        type: "object",
        properties: { id: { type: "string" }, provider: { type: "string" } },
      },
      value: { source: "env", provider: "default", id: REDACTED },
      path,
      hints,
      unsupported: new Set(),
      disabled: false,
      secretFields,
      replaceStoredSecrets: { source: () => literal },
      onPatch: vi.fn(),
    });
    expect(fields.map((field) => field.secretFields)).toEqual([undefined, undefined]);
    expect(fields.map((field) => field.replaceStoredSecrets)).toEqual([undefined, undefined]);
  });

  it("keeps a value from the Gateway environment read-only and names it", () => {
    const secretFields = fakeSecretFields(environment("TELEGRAM_TOKEN"));
    const { input } = render({ value: REDACTED, secretFields });
    expect(input).toMatchObject({
      readOnly: true,
      value: "",
      placeholder: "From environment · TELEGRAM_TOKEN",
    });
    type(input, "new-token");
    expect(secretFields.hold).not.toHaveBeenCalled();

    const channels = render({
      value: REDACTED,
      replace: true,
      source: environment("TELEGRAM_TOKEN"),
    });
    expect(channels.input.readOnly).toBe(true);
    type(channels.input, "new-token");
    expect(channels.onPatch).not.toHaveBeenCalled();
  });

  it("keeps a template, an include, or anything unproven read-only", () => {
    const secretFields = fakeSecretFields(reference);
    const { input } = render({ value: REDACTED, secretFields });
    expect(input).toMatchObject({ readOnly: true, value: "", placeholder: "••••••••" });
    type(input, "new-token");
    expect(secretFields.hold).not.toHaveBeenCalled();

    const channels = render({ value: REDACTED, replace: true, source: reference });
    expect(channels.input.readOnly).toBe(true);
    type(channels.input, "new-token");
    expect(channels.onPatch).not.toHaveBeenCalled();
  });

  it("drops a held edit, and locks, when the stored secret turns out to be a reference", () => {
    const held = fakeSecretFields(literal);
    const container = document.createElement("div");
    const onPatch = vi.fn();
    held.hold(path, "typed-before");
    const fields = { ...held, source: () => reference };
    renderTextInputFixture(container, {
      schema,
      value: REDACTED,
      path,
      inputType: "text",
      hints,
      secretFields: fields,
      onPatch,
    });
    const input = expectElement(container.querySelector<HTMLInputElement>("input"), "input");
    expect(input).toMatchObject({ readOnly: true, value: "" });
    expect(container.querySelector(".cfg-secret-actions")).toBeNull();
  });

  it("refuses the redaction sentinel as a typed value", async () => {
    const secretFields = fakeSecretFields();
    const container = document.createElement("div");
    document.body.append(container);
    try {
      renderTextInputFixture(container, {
        schema,
        value: REDACTED,
        path,
        inputType: "text",
        hints,
        secretFields,
        onPatch: vi.fn(),
      });
      const input = expectElement(container.querySelector<HTMLInputElement>("input"), "input");
      input.focus();
      input.value = `x${REDACTED}`;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      flush();
      expectElement(
        container.querySelector<HTMLButtonElement>('button[aria-label="Save: Bot token"]'),
        "save",
      ).click();
      await Promise.resolve();
      flush();
      expect(secretFields.save).not.toHaveBeenCalled();
      expect(input.validationMessage).not.toBe("");
    } finally {
      container.remove();
    }
  });

  it("keeps typed secrets out of autofill, spellcheck and password managers", () => {
    const secretFields = fakeSecretFields();
    const { input } = render({ value: REDACTED, secretFields });
    type(input, "new-token");
    expect(input).toMatchObject({ autocomplete: "off", spellcheck: false, type: "password" });
    for (const name of ["data-1p-ignore", "data-lpignore", "data-bwignore", "data-form-type"]) {
      expect(input.hasAttribute(name)).toBe(true);
    }
  });

  it("offers no eye on a stored secret, and keeps it for text in the draft", () => {
    const stored = document.createElement("div");
    renderTextInputFixture(stored, {
      schema,
      value: REDACTED,
      path,
      inputType: "text",
      hints,
      onToggleSensitivePath: vi.fn(),
      onPatch: vi.fn(),
    });
    expect(stored.querySelector(".settings-secret__toggle")).toBeNull();
    expect(stored.querySelector("input")?.placeholder).toBe("••••••••");

    const typed = document.createElement("div");
    renderTextInputFixture(typed, {
      schema,
      value: "just-typed",
      path,
      inputType: "text",
      hints,
      onToggleSensitivePath: vi.fn(),
      onPatch: vi.fn(),
    });
    const eye = expectElement(
      typed.querySelector<HTMLButtonElement>(".settings-secret__toggle"),
      "draft reveal toggle",
    );
    expect(eye.disabled).toBe(false);
  });

  it("shows an env placeholder instead of masking it", () => {
    const secretFields = fakeSecretFields();
    const { input } = render({ value: "${TELEGRAM_TOKEN}", secretFields });
    expect(input).toMatchObject({ readOnly: false, value: "${TELEGRAM_TOKEN}", type: "text" });
  });
});
