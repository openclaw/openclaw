import { render } from "lit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCredentialInspection } from "../../../../packages/gateway-protocol/src/schema/plugin-credentials.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import type { OpenClawModalDialog } from "../../components/modal-dialog.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import type { GatewayPageController } from "../../lit/gateway-page-controller.ts";
import {
  PluginCredentialEditor,
  renderPluginCredential,
  type PluginCredentialEditorContext,
} from "./credential-editor.ts";

afterEach(() => {
  document.body.replaceChildren();
});
const path = ["plugins", "entries", "example", "config", "key"];
const descriptor = {
  path,
  label: "Example API key",
  envVars: ["EXAMPLE_KEY"],
  signupUrl: "https://example.com/keys",
  placeholder: "example-…",
};

async function mount(state: PluginCredentialInspection = { kind: "literal" }, width = 390) {
  const { page } = await import("vitest/browser");
  await page.viewport(width, 844);
  const scope = {
    client: { request: vi.fn().mockResolvedValue({ baseHash: "revision", credential: state }) },
    epoch: 1,
  };
  const gateway = {
    epoch: 1,
    connected: true,
    capture: () => scope,
    isCurrent: (candidate: unknown) => candidate === scope,
  } as unknown as GatewayPageController;
  const context: PluginCredentialEditorContext = {
    pluginId: "example",
    baseHash: "revision",
    gateway,
    canInspect: true,
    onCommit: vi.fn().mockResolvedValue(true),
    onDiscard: vi.fn().mockResolvedValue(true),
  };
  const field = {
    path,
    value: state.kind === "reference" ? { ...state.ref, id: REDACTED_SENTINEL } : REDACTED_SENTINEL,
    disabled: false,
    descriptionId: "credential-help",
    onPatch: vi.fn(),
  };
  const host = document.createElement("div");
  host.style.cssText = "padding:16px;box-sizing:border-box;width:100%";
  const help = document.createElement("p");
  help.id = field.descriptionId;
  help.textContent = "Provider-owned credential help.";
  document.body.append(help, host);
  const update = async () => {
    render(renderPluginCredential({ ...field }, descriptor, { ...context }), host);
    await editor.updateComplete;
  };
  render(renderPluginCredential(field, descriptor, context), host);
  const editor = host.querySelector<PluginCredentialEditor>("openclaw-plugin-credential-editor")!;
  await editor.updateComplete;
  await vi.waitFor(() => expect(scope.client.request).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(editor.textContent).not.toContain("Loading"));
  return { editor, scope, context, field, update };
}
function button(editor: Element, text: string) {
  const result = [...editor.querySelectorAll("button")].find(
    (element) => element.textContent?.trim() === text,
  );
  expect(result, text).toBeDefined();
  return result!;
}
async function open(editor: PluginCredentialEditor, text = "Edit reference") {
  const trigger = button(editor, text);
  trigger.focus();
  trigger.click();
  await editor.updateComplete;
  const modal = editor.querySelector<OpenClawModalDialog>("openclaw-modal-dialog")!;
  await modal.updateComplete;
  const wa = modal.shadowRoot!.querySelector("wa-dialog")!;
  await wa.updateComplete;
  const dialog = wa.shadowRoot!.querySelector("dialog")!;
  await vi.waitFor(() => expect(dialog.open).toBe(true));
  await Promise.all(dialog.getAnimations().map((animation) => animation.finished));
  return { dialog, trigger };
}
function editInput(element: HTMLInputElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("plugin credential authoring controls", () => {
  it.each(["button", "modal"])(
    "keeps the dialog open for a pending Save via %s dismissal",
    async (dismissal) => {
      const { editor, context } = await mount({
        kind: "reference",
        ref: { source: "env", provider: "default", id: "ORIGINAL_KEY" },
        unresolved: false,
      });
      const pending = createDeferred<boolean>();
      vi.mocked(context.onCommit).mockReturnValue(pending.promise);
      await open(editor);
      button(editor, "Save").click();
      await editor.updateComplete;
      if (dismissal === "button") {
        expect(button(editor, "Cancel").disabled).toBe(true);
        button(editor, "Cancel").click();
      } else {
        const event = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
        editor.querySelector("openclaw-modal-dialog")!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      await editor.updateComplete;
      expect(editor.querySelector("openclaw-modal-dialog")).not.toBeNull();
      pending.resolve(true);
      await vi.waitFor(() => expect(editor.querySelector("openclaw-modal-dialog")).toBeNull());
    },
  );

  it("preserves an uncommitted literal while an unrelated configuration revision arrives", async () => {
    const { editor, context, scope, update } = await mount();
    const input = editor.querySelector<HTMLInputElement>("input")!;
    input.focus();
    editInput(input, "synthetic-pending-key");
    context.baseHash = "next-revision";
    scope.client.request.mockResolvedValue({
      baseHash: "next-revision",
      credential: { kind: "literal" },
    });
    await update();
    expect(input.value).toBe("synthetic-pending-key");
    expect(context.onCommit).not.toHaveBeenCalled();
    input.blur();
    await vi.waitFor(() =>
      expect(context.onCommit).toHaveBeenCalledWith(path, "synthetic-pending-key"),
    );
  });

  it("commits when focus leaves for another credential, but not its own reveal button", async () => {
    const first = await mount();
    const second = await mount();
    second.field.path = [...path.slice(0, -1), "otherKey"];
    await second.update();
    const input = first.editor.querySelector<HTMLInputElement>("input")!;
    input.focus();
    editInput(input, "synthetic-first-key");
    await first.editor.updateComplete;
    first.editor.querySelector<HTMLButtonElement>('[aria-label="Show entered key"]')!.focus();
    expect(first.context.onCommit).not.toHaveBeenCalled();
    second.editor.querySelector<HTMLInputElement>("input")!.focus();
    await vi.waitFor(() => expect(first.context.onCommit).toHaveBeenCalledOnce());
    expect(first.context.onCommit).toHaveBeenCalledWith(path, "synthetic-first-key");
    expect(second.context.onCommit).not.toHaveBeenCalled();
  });

  it("never puts the stored sentinel into an editable input; reveal affects only the entered draft", async () => {
    const { editor, context } = await mount();
    const field = editor.querySelector<HTMLInputElement>("input")!;
    expect(field.getAttribute("aria-describedby")).toBe("credential-help");
    expect(field.value).toBe("");
    expect(field.placeholder).toBe("••••••••");
    expect(editor.querySelector("a")?.href).toBe("https://example.com/keys");
    field.focus();
    field.blur();
    expect(context.onCommit).not.toHaveBeenCalled();
    editInput(field, "synthetic-new-key");
    await editor.updateComplete;
    editor.querySelector<HTMLButtonElement>('[aria-label="Show entered key"]')!.click();
    await editor.updateComplete;
    expect(field.type).toBe("text");
    expect(field.value).toBe("synthetic-new-key");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(context.onCommit).toHaveBeenCalledWith(path, "synthetic-new-key"),
    );
  });

  it.each(["env", "file", "exec", "store"] as const)(
    "inspects and edits the exact %s pointer; Cancel never patches",
    async (source) => {
      const id = source === "file" ? "/original/key" : "ORIGINAL_KEY";
      const { editor, context } = await mount({
        kind: "reference",
        ref: { source, provider: "original", id },
        unresolved: false,
      });
      const { trigger } = await open(editor);
      expect(trigger.getAttribute("aria-describedby")).toBe("credential-help");
      expect(editor.querySelector<HTMLSelectElement>("select")!.value).toBe(source);
      const inputs = editor.querySelectorAll<HTMLInputElement>(".plugin-credential__dialog input");
      expect(inputs[0]!.value).toBe("original");
      expect(inputs[1]!.value).toBe(id);
      editInput(inputs[0]!, "changed");
      button(editor, "Cancel").click();
      await editor.updateComplete;
      expect(context.onCommit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
      await open(editor);
      const next = editor.querySelectorAll<HTMLInputElement>(".plugin-credential__dialog input");
      expect(next[0]!.value).toBe("original");
      editInput(next[0]!, "changed");
      await editor.updateComplete;
      button(editor, "Save").click();
      await vi.waitFor(() =>
        expect(context.onCommit).toHaveBeenCalledWith(path, { source, provider: "changed", id }),
      );
    },
  );

  it("retains the reference draft and Cancel on write failure until the existing owner acknowledges retry", async () => {
    const { editor, context } = await mount({
      kind: "reference",
      ref: { source: "env", provider: "default", id: "ORIGINAL_KEY" },
      unresolved: true,
    });
    vi.mocked(context.onCommit).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await open(editor);
    const id = editor.querySelectorAll<HTMLInputElement>(".plugin-credential__dialog input")[1]!;
    editInput(id, "CHANGED_KEY");
    await editor.updateComplete;
    button(editor, "Save").click();
    await vi.waitFor(() =>
      expect(editor.querySelector('[role="alert"]')?.textContent).toContain("could not be saved"),
    );
    expect(id.value).toBe("CHANGED_KEY");
    expect(button(editor, "Cancel")).toBeDefined();
    button(editor, "Save").click();
    await vi.waitFor(() => expect(editor.querySelector("openclaw-modal-dialog")).toBeNull());
  });

  it("keeps environment fallback inspect-only and validates source-specific identifiers", async () => {
    const { editor, context } = await mount({ kind: "environment", envVar: "EXAMPLE_KEY" });
    await open(editor, "View source");
    expect(editor.querySelector(".plugin-credential__dialog input")).toBeNull();
    expect(editor.textContent).toContain("Change that environment variable at its source");
    expect(context.onCommit).not.toHaveBeenCalled();
  });

  it.each([390, 768, 1174])(
    "keeps input, signup link and reference dialog within %dpx",
    async (width) => {
      const { editor } = await mount({ kind: "missing" }, width);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
      const { dialog } = await open(editor, "Use a secret reference");
      const rect = dialog.getBoundingClientRect();
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(width);
      expect(rect.bottom).toBeLessThanOrEqual(844);
      const input = editor.querySelectorAll<HTMLInputElement>(
        ".plugin-credential__dialog input",
      )[1]!;
      input.value = "invalid lower-case env id";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await editor.updateComplete;
      expect(button(editor, "Save").disabled).toBe(true);
    },
  );

  it("rejects stale open-reference edits after config revision changes, and clears inspection on Gateway retirement", async () => {
    const { editor, context, update } = await mount({
      kind: "reference",
      ref: { source: "env", provider: "default", id: "ORIGINAL_KEY" },
      unresolved: false,
    });
    await open(editor);
    context.baseHash = "different";
    await update();
    expect(editor.textContent).toContain("Configuration changed");
    expect(button(editor, "Save").disabled).toBe(true);
    context.gateway = {
      epoch: 2,
      connected: false,
      capture: () => null,
      isCurrent: () => false,
    } as unknown as GatewayPageController;
    await update();
    expect(editor.querySelector("openclaw-modal-dialog")).toBeNull();
    expect(context.onCommit).not.toHaveBeenCalled();
  });

  it.each(["plugin", "permission"])(
    "clears private reference metadata after %s identity changes",
    async (change) => {
      const { editor, context, update } = await mount({
        kind: "reference",
        ref: { source: "file", provider: "vault", id: "/private/key" },
        unresolved: false,
      });
      await open(editor);
      if (change === "plugin") {
        context.pluginId = "different";
      } else {
        context.canInspect = false;
      }
      await update();
      expect(editor.querySelector("openclaw-modal-dialog")).toBeNull();
      expect(editor.querySelector("input")?.value).not.toBe("/private/key");
      expect(context.onCommit).not.toHaveBeenCalled();
    },
  );

  it("lets an administrator inspect a read-only reference without changing it", async () => {
    const { editor, context, field, update } = await mount({
      kind: "reference",
      ref: { source: "env", provider: "default", id: "EXAMPLE_KEY" },
      unresolved: false,
    });
    field.disabled = true;
    await update();
    await open(editor);
    expect(button(editor, "Save").disabled).toBe(true);
    expect(
      [...editor.querySelectorAll<HTMLInputElement>(".plugin-credential__dialog input")].every(
        (input) => input.disabled,
      ),
    ).toBe(true);
    expect(context.onCommit).not.toHaveBeenCalled();
  });
});
