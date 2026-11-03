import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { ADVANCED_EXCLUDED_SECTIONS, configSectionKeysForPage } from "./config-sections.ts";
import {
  requiredConfigElement,
  renderConfigInto,
  renderConfigView,
} from "./config-view.test-support.tsx";

const schema = {
  type: "object",
  properties: { gateway: { type: "object", properties: { mode: { type: "string" } } } },
};

it("renders and retries a failed initial configuration read", async () => {
  const failed = createDeferred<{ ok: false; error: string }>();
  const retried = createDeferred<{ ok: true; value: undefined }>();
  const onRetryConfig = vi.fn(() => {
    props.loading = true;
    props.configRead = retried.promise;
    renderConfigInto(props, container);
  });
  const { container, props } = renderConfigView({
    schema,
    configLoaded: false,
    configRead: failed.promise,
    onRetryConfig,
    loading: true,
    formValue: null,
    forceShowAdvanced: true,
  });
  expect(container.querySelector(".config-loading")).not.toBeNull();
  expect(container.querySelector(".config-content input")).toBeNull();
  failed.resolve({ ok: false, error: "Configuration request failed" });
  props.loading = false;
  renderConfigInto(props, container);
  await waitForSolid(() =>
    expect(
      container.querySelector('.config-content-callout [role="alert"]')?.textContent,
    ).toContain("Configuration request failed"),
  );
  container
    .querySelector<HTMLButtonElement>('.config-content-callout [role="alert"] button')!
    .click();
  await waitForSolid(() => expect(container.querySelector(".config-loading")).not.toBeNull());
  props.formValue = { gateway: { mode: "local" } };
  props.configLoaded = true;
  props.loading = false;
  retried.resolve({ ok: true, value: undefined });
  renderConfigInto(props, container);
  await waitForSolid(() => expect(container.querySelector(".config-content input")).not.toBeNull());
  expect(container.querySelector('.config-content-callout [role="alert"]')).toBeNull();
});

it("keeps a loaded editor mounted and locked during configuration refresh", async () => {
  const read = createDeferred<{ ok: true; value: undefined }>();
  const { container, props } = renderConfigView({
    schema,
    formValue: { gateway: { mode: "local" } },
    forceShowAdvanced: true,
  });
  const field = container.querySelector<HTMLInputElement>(".config-content input")!;
  props.configRead = read.promise;
  props.loading = true;
  renderConfigInto(props, container);
  expect(container.querySelector(".config-loading")).toBeNull();
  expect(container.querySelector(".config-content input")).toBe(field);
  expect(field.disabled).toBe(true);
  read.resolve({ ok: true, value: undefined });
  props.loading = false;
  renderConfigInto(props, container);
  await waitForSolid(() => expect(field.disabled).toBe(false));
  expect(container.querySelector(".config-content input")).toBe(field);
});

it("keeps the blocked editor when an initial read requires publication recovery", async () => {
  const { container } = renderConfigView({
    schema,
    configLoaded: false,
    configRecoveryError: "Inspect the configuration backup before reloading.",
    configRead: Promise.resolve({ ok: false, error: "Configuration recovery required" }),
    formValue: null,
    forceShowAdvanced: true,
  });
  await waitForSolid(() => {
    const field = container.querySelector<HTMLInputElement>(".config-content input");
    expect(field?.disabled).toBe(true);
  });
  expect(container.querySelector('.config-content-callout [role="alert"]')).toBeNull();
});

it("publishes the config owner before presenting a raw Save and stays busy until it settles", async () => {
  const completion = createDeferred<boolean>();
  const save = vi.fn(() => {
    props.valid = false;
    renderConfigInto(props, container);
    return completion.promise;
  });
  const { container, props } = renderConfigView({
    formMode: "raw",
    raw: '{"gateway":{"mode":"local"}}',
    originalRaw: "{}",
    onSave: save,
  });
  const button = container.querySelector<HTMLButtonElement>(".config-raw-actions button.primary")!;
  const textarea = container.querySelector("textarea");
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));
  expect(container.querySelector(".config-validity-warning")).not.toBeNull();
  expect(button.textContent).toContain("Saving");
  button.click();
  expect(save).toHaveBeenCalledOnce();
  completion.resolve(true);
  await waitForSolid(() => expect(button.disabled).toBe(false));
  expect(button.textContent?.trim()).toBe("Save");
  expect(container.querySelector("textarea")).toBe(textarea);
});

it.each(["Open", "Discard"])(
  "locks raw controls during %s without showing Saving",
  async (label) => {
    const completion = createDeferred();
    const command = vi.fn(() => completion.promise);
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{"gateway":{"mode":"local"}}',
      originalRaw: "{}",
      onOpenFile: command,
      onRawDiscard: command,
    });
    const buttons = Array.from(
      container.querySelectorAll<HTMLButtonElement>(".config-raw-actions button"),
    );
    buttons.find((button) => button.textContent?.trim() === label)!.click();
    await waitForSolid(() => expect(buttons.every((button) => button.disabled)).toBe(true));
    const save = buttons.find((button) => button.classList.contains("primary"))!;
    expect(save.textContent?.trim()).toBe("Save");
    expect(save.getAttribute("aria-busy")).toBe("false");
    expect(container.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(true);
    completion.resolve();
    await waitForSolid(() => expect(buttons.every((button) => !button.disabled)).toBe(true));
  },
);

it("releases a raw save presentation when its owner retires the route", async () => {
  const completion = createDeferred<boolean>();
  let lifetime = Promise.withResolvers<void>();
  const { container, props } = renderConfigView({
    formMode: "raw",
    raw: '{"gateway":{"mode":"local"}}',
    originalRaw: "{}",
    onSave: () => completion.promise,
    presentationRetired: () => lifetime.promise,
  });
  const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (button) => button.textContent?.trim() === "Save",
  )!;
  save.click();
  await waitForSolid(() => expect(save.textContent).toContain("Saving"));
  lifetime.resolve();
  lifetime = Promise.withResolvers<void>();
  props.formMode = "form";
  renderConfigInto(props, container);
  await waitForSolid(() => expect(container.querySelector("textarea")).toBeNull());
  completion.resolve(true);
  await completion.promise;
});

it.each(["includeSections", "excludeSections"] as const)(
  "keeps native drafts live across aggregate props replacements with held %s",
  async (scope) => {
    const scopedSchema = (title: string) => ({
      type: "object",
      properties: {
        logging: { type: "object", properties: { value: { type: "string", title } } },
        mcp: { type: "object", properties: { value: { type: "string", title } } },
      },
    });
    const section = scope === "includeSections" ? "mcp" : "logging";
    const onFormPatch = vi.fn((_path: (string | number)[], value: unknown) => {
      props.formValue = { ...props.formValue, [section]: { value } };
      renderConfigInto(props, container);
    });
    const { container, props } = renderConfigView({
      onFormPatch,
      schema: scopedSchema("Scoped value"),
      [scope]:
        scope === "includeSections" ? configSectionKeysForPage("mcp") : ADVANCED_EXCLUDED_SECTIONS,
      includeVirtualSections: false,
      forceShowAdvanced: true,
      formValue: { logging: { value: "initial" }, mcp: { value: "initial" } },
    });
    document.body.append(container);
    try {
      await waitForSolid(() =>
        expect(container.querySelectorAll("input.settings-input")).toHaveLength(1),
      );
      const field = requiredConfigElement(
        container,
        'input[aria-label="Scoped value"]',
        HTMLInputElement,
      );
      const { userEvent } = await import("vitest/browser");
      field.focus();
      await userEvent.keyboard("{End}-draft");
      expect(props.onFormPatch).toHaveBeenLastCalledWith(
        [scope === "includeSections" ? "mcp" : "logging", "value"],
        "initial-draft",
      );
      field.setSelectionRange(1, 4);
      renderConfigInto({ ...props, assistantName: "Unrelated publication" }, container);
      expect(container.querySelector("input.settings-input")).toBe(field);
      expect(field.value).toBe("initial-draft");
      expect(document.activeElement).toBe(field);
      expect([field.selectionStart, field.selectionEnd]).toEqual([1, 4]);

      // Disabling a native field may blur it; identity and its draft must survive.
      renderConfigInto({ ...props, loading: true }, container);
      expect(field.disabled).toBe(true);
      renderConfigInto({ ...props, loading: false }, container);
      expect(field.disabled).toBe(false);
      expect(field.value).toBe("initial-draft");
      field.focus();
      renderConfigInto({ ...props, schema: scopedSchema("Replacement label") }, container);
      await waitForSolid(() =>
        expect(container.querySelector('input[aria-label="Replacement label"]')).toBe(field),
      );
      expect(field.value).toBe("initial-draft");
      expect(document.activeElement).toBe(field);

      renderConfigInto({ ...props, [scope]: ["logging"] }, container);
      await waitForSolid(() => {
        expect(field.isConnected).toBe(false);
        expect(container.querySelectorAll("input.settings-input")).toHaveLength(1);
      });
      renderConfigInto({ ...props, [scope]: [] }, container);
      await waitForSolid(() =>
        expect(container.querySelectorAll("input.settings-input")).toHaveLength(2),
      );
    } finally {
      container.remove();
    }
  },
);
