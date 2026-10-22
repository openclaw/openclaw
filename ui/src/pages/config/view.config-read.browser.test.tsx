import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { waitForSolid } from "../../test-helpers/solid-settle.ts";
import { renderConfigInto, renderConfigView } from "./config-view.test-support.tsx";

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
  expect(onRetryConfig).toHaveBeenCalledOnce();
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
  expect(field).not.toBeNull();
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
    expect(field).not.toBeNull();
    expect(field?.disabled).toBe(true);
  });
  expect(container.querySelector('.config-content-callout [role="alert"]')).toBeNull();
});

it("keeps the raw Save command busy until its owner settles", async () => {
  const completion = createDeferred<boolean>();
  const save = vi.fn(() => completion.promise);
  const lifetime = Promise.withResolvers<void>();
  const { container } = renderConfigView({
    formMode: "raw",
    raw: '{"gateway":{"mode":"local"}}',
    originalRaw: "{}",
    onSave: save,
    presentationRetired: () => lifetime.promise,
  });
  const button = container.querySelector<HTMLButtonElement>(".config-raw-actions button.primary")!;
  const textarea = container.querySelector("textarea");
  button.click();
  await waitForSolid(() => expect(button.disabled).toBe(true));
  expect(button.textContent).toContain("Saving");
  button.click();
  expect(save).toHaveBeenCalledOnce();
  completion.resolve(true);
  await waitForSolid(() => expect(button.disabled).toBe(false));
  expect(button.textContent?.trim()).toBe("Save");
  expect(container.querySelector("textarea")).toBe(textarea);
});

it("publishes the plain config owner before entering the save presentation", async () => {
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
  container.querySelector<HTMLButtonElement>(".config-raw-actions button.primary")!.click();
  await waitForSolid(() =>
    expect(container.querySelector(".config-validity-warning")).not.toBeNull(),
  );
  expect(save).toHaveBeenCalledOnce();
  completion.resolve(true);
  await completion.promise;
});

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
