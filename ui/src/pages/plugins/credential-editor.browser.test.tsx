import { createSignal, flush } from "solid-js";
import { expect, it, vi } from "vitest";
import type { PluginCredentialInspection } from "../../../../packages/gateway-protocol/src/schema/plugin-credentials.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { domProbe } from "../../test-helpers/dom-probe.ts";
import { nextFrame } from "../../test-helpers/modal-dialog.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  PluginCredentialEditor,
  type PluginCredentialEditorContext as Context,
} from "./credential-editor.tsx";

const path = ["plugins", "entries", "example", "config", "key"];
const inspectParams = { pluginId: "example", path, baseHash: "revision" };
const descriptor = {
  path,
  label: "Example API key",
  envVars: ["EXAMPLE_KEY"],
  signupUrl: "https://example.com/keys",
  placeholder: "example-…",
};
const reference = (
  source: "env" | "file" = "env",
  id = "ORIGINAL_KEY",
  provider = "default",
  unresolved = false,
): PluginCredentialInspection => ({ kind: "reference", ref: { source, id, provider }, unresolved });
const inspection = (credential: PluginCredentialInspection, baseHash = "revision") => ({
  baseHash,
  credential,
});
const retiredGateway = () =>
  ({
    epoch: 2,
    connected: false,
    capture: () => null,
    isCurrent: () => false,
  }) as unknown as GatewayPageBinding;
const dialogInputs = (editor: Element) =>
  editor.querySelectorAll<HTMLInputElement>(".plugin-credential__dialog input");
const modal = (editor: Element) => editor.querySelector("openclaw-modal-dialog");
const revealButton = (editor: Element, action = "Show") =>
  editor.querySelector<HTMLButtonElement>(`[aria-label="${action} API key: Example API key"]`)!;

async function mount(state: PluginCredentialInspection = { kind: "literal" }, width = 390) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);
  const scope = {
    client: { request: vi.fn().mockResolvedValue(inspection(state)) },
    epoch: 1,
  };
  const gateway = {
    client: scope.client,
    epoch: 1,
    connected: true,
    capture: () => scope,
    isCurrent: (candidate: unknown) => candidate === scope,
  } as unknown as GatewayPageBinding;
  const context: Context = {
    pluginId: "example",
    baseHash: "revision",
    gateway,
    canInspect: true,
    onCommit: vi.fn().mockResolvedValue(true),
    onDiscard: vi.fn().mockResolvedValue(true),
  };
  const field = {
    path,
    value:
      state.kind === "reference"
        ? { ...state.ref, id: REDACTED_SENTINEL }
        : state.kind === "literal"
          ? REDACTED_SENTINEL
          : undefined,
    disabled: false,
    descriptionId: "credential-help",
  };
  const [props, setProps] = createSignal({ field: { ...field }, context: { ...context } });
  const { container } = mountSolid(() => (
    <>
      <p id={field.descriptionId}>Provider-owned credential help.</p>
      <div style={{ padding: "16px", "box-sizing": "border-box", width: "100%" }}>
        <PluginCredentialEditor {...props()} descriptor={descriptor} />
      </div>
    </>
  ));
  const editor = container.querySelector<HTMLElement>("openclaw-plugin-credential-editor")!;
  const update = async (
    contextChanges: Partial<Context> = {},
    fieldChanges: Partial<typeof field> = {},
  ) => {
    Object.assign(context, contextChanges);
    Object.assign(field, fieldChanges);
    setProps({ field: { ...field }, context: { ...context } });
    flush();
  };
  flush();
  await vi.waitFor(() => expect(scope.client.request).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(editor.textContent).not.toContain("Loading"));
  return {
    editor,
    scope,
    context,
    update,
    click: (label: string) => clickButton(editor, label),
    ...domProbe(editor),
    get input() {
      return editor.querySelector<HTMLInputElement>("input")!;
    },
    committed: (value: unknown) =>
      vi.waitFor(() => expect(context.onCommit).toHaveBeenCalledWith(path, value)),
  };
}
function clickButton(editor: Element, label: string) {
  button(editor, label).click();
  flush();
}
function button(editor: Element, text: string) {
  const result = [...editor.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  expect(result, text).toBeDefined();
  return result!;
}
async function open(editor: HTMLElement, text = "Edit reference") {
  const trigger = button(editor, text);
  trigger.focus();
  trigger.click();
  flush();
  const host = modal(editor)!;
  await host.updateComplete;
  const dialog = host.querySelector("dialog")!;
  await vi.waitFor(() => expect(dialog.open).toBe(true));
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  return { dialog, trigger };
}
function editInput(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

it("preserves literal and reference drafts through same-client reconnects", async () => {
  const { editor, context, update, input } = await mount();
  editInput(input, "synthetic-unsaved-key");
  await open(editor, "Use a secret reference");
  const referenceInput = dialogInputs(editor)[1]!;
  editInput(referenceInput, "DRAFT_KEY");
  const gateway = context.gateway;
  const connectedGateway = { ...gateway };
  Object.assign(gateway, retiredGateway());
  await update({}, { disabled: true });
  expect([input.value, referenceInput.value]).toEqual(["synthetic-unsaved-key", "DRAFT_KEY"]);
  expect(modal(editor)).not.toBeNull();
  expect(button(editor, "Save").disabled).toBe(true);
  Object.assign(gateway, connectedGateway, { epoch: 3 });
  await update({}, { disabled: false });
  await vi.waitFor(() => expect(button(editor, "Save").disabled).toBe(false));
  expect([input.value, referenceInput.value]).toEqual(["synthetic-unsaved-key", "DRAFT_KEY"]);
  expect(context.onCommit).not.toHaveBeenCalled();
  await update({ pluginId: "replacement" });
  expect(input.value).toBe("");
  expect(modal(editor)).toBeNull();
});

it.each(["button", "modal"])("blocks %s dismissal during Save", async (dismissal) => {
  const { editor, context, click } = await mount(reference());
  const pending = createDeferred<boolean>();
  vi.mocked(context.onCommit).mockReturnValue(pending.promise);
  await open(editor);
  click("Save");
  if (dismissal === "button") {
    click("Cancel");
  } else {
    const event = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
    modal(editor)!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  }
  flush();
  expect(modal(editor)).not.toBeNull();
  expect(button(editor, "Cancel").disabled).toBe(true);
  pending.resolve(true);
  await vi.waitFor(() => expect(modal(editor)).toBeNull());
});

it("keeps a successor reference busy when a retired save completes", async () => {
  const { editor, context, scope, update, click } = await mount(reference());
  const retired = createDeferred<boolean>();
  const successor = createDeferred<boolean>();
  vi.mocked(context.onCommit)
    .mockReturnValueOnce(retired.promise)
    .mockReturnValueOnce(successor.promise);
  await open(editor);
  click("Save");
  await update({ pluginId: "replacement" });
  await vi.waitFor(() => expect(scope.client.request).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(editor.textContent).not.toContain("Loading"));
  await open(editor);
  const id = dialogInputs(editor)[1]!;
  editInput(id, "SUCCESSOR_KEY");
  flush();
  click("Save");
  expect(context.onCommit).toHaveBeenCalledTimes(2);

  retired.resolve(true);
  await retired.promise;
  await nextFrame();
  flush();
  expect(modal(editor)).not.toBeNull();
  expect(id.value).toBe("SUCCESSOR_KEY");
  expect(button(editor, "Saving…").disabled).toBe(true);
  expect(button(editor, "Cancel").disabled).toBe(true);

  successor.resolve(true);
  await vi.waitFor(() => expect(modal(editor)).toBeNull());
});

it("preserves an uncommitted literal across unrelated config revisions", async () => {
  const { context, scope, update, input, committed } = await mount();
  input.focus();
  editInput(input, "synthetic-pending-key");
  scope.client.request.mockResolvedValue(inspection({ kind: "literal" }, "next-revision"));
  await update({ baseHash: "next-revision" });
  expect(input.value).toBe("synthetic-pending-key");
  expect(context.onCommit).not.toHaveBeenCalled();
  input.blur();
  await committed("synthetic-pending-key");
});

it("commits when focus leaves for another credential, but not its own reveal button", async () => {
  const first = await mount();
  const second = await mount();
  await second.update({}, { path: [...path.slice(0, -1), "otherKey"] });
  const input = first.input;
  input.focus();
  editInput(input, "synthetic-first-key");
  revealButton(first.editor).focus();
  expect(first.context.onCommit).not.toHaveBeenCalled();
  second.input.focus();
  await vi.waitFor(() => expect(first.context.onCommit).toHaveBeenCalledOnce());
  expect(first.context.onCommit).toHaveBeenCalledWith(path, "synthetic-first-key");
  expect(second.context.onCommit).not.toHaveBeenCalled();
});

it("reveals stored literals only on request, without committing, and clears on hide", async () => {
  const { editor, scope, context, input } = await mount();
  const reveal = revealButton(editor);
  expect(input.value).toBe("");
  expect(scope.client.request).toHaveBeenCalledWith("plugins.credentials.inspect", inspectParams);
  expect(reveal.disabled).toBe(false);
  scope.client.request.mockResolvedValue(
    inspection({ kind: "literal", value: "synthetic-stored-key" }),
  );
  reveal.click();
  await vi.waitFor(() =>
    expect(input).toMatchObject({ value: "synthetic-stored-key", type: "text" }),
  );
  expect(scope.client.request).toHaveBeenLastCalledWith("plugins.credentials.inspect", {
    ...inspectParams,
    reveal: true,
  });
  input.focus();
  input.blur();
  expect(context.onCommit).not.toHaveBeenCalled();
  revealButton(editor, "Hide").click();
  flush();
  expect(input).toMatchObject({ value: "", type: "password" });
});

it.each<[string, Partial<Context>, string[]]>([
  ["revision", { baseHash: "new-revision" }, path],
  ["connection", { gateway: retiredGateway() }, path],
  ["permission", { canInspect: false }, path],
  ["field", {}, [...path.slice(0, -1), "otherKey"]],
])("retires reveals on %s", async (_change, contextChanges, fieldPath) => {
  const { editor, scope, context, update, query } = await mount();
  const pending = createDeferred<unknown>();
  scope.client.request
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValue(inspection({ kind: "literal" }, "new-revision"));
  revealButton(editor).click();
  await vi.waitFor(() => expect(scope.client.request).toHaveBeenCalledTimes(2));
  await update(contextChanges, { path: fieldPath });
  pending.resolve(inspection({ kind: "literal", value: "stale-private-key" }));
  await pending.promise;
  flush();
  expect(query<HTMLInputElement>("input")?.value).toBe("");
  expect(editor.innerHTML).not.toContain("stale-private-key");
  expect(context.onCommit).not.toHaveBeenCalled();
});

it("keeps the stored sentinel out of edits and reveals entered drafts locally", async () => {
  const { editor, context, input, committed, attr, query } = await mount();
  expect(attr("input", "aria-describedby")).toBe("credential-help");
  expect(input).toMatchObject({ value: "", placeholder: "••••••••" });
  expect(query("a")?.href).toBe("https://example.com/keys");
  input.focus();
  input.blur();
  expect(context.onCommit).not.toHaveBeenCalled();
  editInput(input, "synthetic-new-key");
  flush();
  revealButton(editor).click();
  flush();
  expect(input).toMatchObject({ type: "text", value: "synthetic-new-key" });
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await committed("synthetic-new-key");
});

it.each(["env", "file"] as const)("edits %s references; Cancel never patches", async (source) => {
  const id = source === "file" ? "/original/key" : "ORIGINAL_KEY";
  const { editor, context, committed, click } = await mount(reference(source, id, "original"));
  const { trigger } = await open(editor);
  expect(trigger.getAttribute("aria-describedby")).toBe("credential-help");
  expect(editor.querySelector<HTMLSelectElement>("select")!.value).toBe(source);
  const inputs = dialogInputs(editor);
  expect([...inputs].map((input) => input.value)).toEqual(["original", id]);
  editInput(inputs[0]!, "changed");
  click("Cancel");
  expect(context.onCommit).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  await open(editor);
  const next = dialogInputs(editor);
  expect(next[0]!.value).toBe("original");
  editInput(next[0]!, "changed");
  flush();
  click("Save");
  await committed({ source, provider: "changed", id });
});

it("retains the reference draft and Cancel until a failed write's retry succeeds", async () => {
  const { editor, context, text, click } = await mount(
    reference("env", "ORIGINAL_KEY", "default", true),
  );
  vi.mocked(context.onCommit).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  await open(editor);
  const id = dialogInputs(editor)[1]!;
  editInput(id, "CHANGED_KEY");
  flush();
  click("Save");
  await vi.waitFor(() => expect(text('[role="alert"]')).toContain("could not be saved"));
  expect(id.value).toBe("CHANGED_KEY");
  expect(button(editor, "Cancel")).toBeDefined();
  click("Save");
  await vi.waitFor(() => expect(modal(editor)).toBeNull());
});

it("keeps environment fallback inspect-only", async () => {
  const { editor, context, query } = await mount({ kind: "environment", envVar: "EXAMPLE_KEY" });
  await open(editor, "View source");
  expect(query(".plugin-credential__dialog input")).toBeNull();
  expect(editor.textContent).toContain("Change that environment variable at its source");
  expect(context.onCommit).not.toHaveBeenCalled();
});

it("keeps controls within a mobile viewport and rejects invalid environment IDs", async () => {
  const width = 390;
  const { editor } = await mount({ kind: "missing" }, width);
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const { dialog } = await open(editor, "Use a secret reference");
  const rect = dialog.getBoundingClientRect();
  expect(rect.left).toBeGreaterThanOrEqual(0);
  expect(rect.right).toBeLessThanOrEqual(width);
  expect(rect.bottom).toBeLessThanOrEqual(844);
  const input = dialogInputs(editor)[1]!;
  editInput(input, "invalid lower-case env id");
  flush();
  expect(button(editor, "Save").disabled).toBe(true);
});

it("rejects stale reference edits after config changes and clears on Gateway retirement", async () => {
  const { editor, context, update } = await mount(reference());
  await open(editor);
  await update({ baseHash: "different" });
  expect(editor.textContent).toContain("Configuration changed");
  expect(button(editor, "Save").disabled).toBe(true);
  await update({ gateway: retiredGateway() });
  expect(modal(editor)).toBeNull();
  expect(context.onCommit).not.toHaveBeenCalled();
});

it.each(["plugin", "permission"])("retires private references on %s changes", async (change) => {
  const { editor, context, update, query } = await mount(
    reference("file", "/private/key", "vault"),
  );
  await open(editor);
  await update(change === "plugin" ? { pluginId: "different" } : { canInspect: false });
  expect(modal(editor)).toBeNull();
  expect(query("input")?.value).not.toBe("/private/key");
  expect(context.onCommit).not.toHaveBeenCalled();
});

it("lets an administrator inspect a read-only reference without changing it", async () => {
  const { editor, context, update } = await mount(reference("env", "EXAMPLE_KEY"));
  await update({}, { disabled: true });
  await open(editor);
  expect(button(editor, "Save").disabled).toBe(true);
  expect([...dialogInputs(editor)].every((input) => input.disabled)).toBe(true);
  expect(context.onCommit).not.toHaveBeenCalled();
});
