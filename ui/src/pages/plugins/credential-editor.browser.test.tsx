import { createSignal, flush } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginCredentialInspection } from "../../../../packages/gateway-protocol/src/schema/plugin-credentials.ts";
import { createDeferred } from "../../../../test/helpers/promise.ts";
import { REDACTED_SENTINEL } from "../../lib/config-form-utils.ts";
import type { GatewayPageBinding } from "../../lib/gateway-page-binding.ts";
import { domProbe } from "../../test-helpers/dom-probe.ts";
import { mountSolid } from "../../test-helpers/mount-solid.ts";
import {
  PluginCredentialEditor,
  type PluginCredentialEditorContext,
} from "./credential-editor.tsx";

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
const reference = (
  ref: Extract<PluginCredentialInspection, { kind: "reference" }>["ref"] = {
    source: "env",
    provider: "default",
    id: "ORIGINAL_KEY",
  },
  unresolved = false,
): PluginCredentialInspection => ({ kind: "reference", ref, unresolved });
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
    client: { request: vi.fn().mockResolvedValue({ baseHash: "revision", credential: state }) },
    epoch: 1,
  };
  const gateway = {
    client: scope.client,
    epoch: 1,
    connected: true,
    capture: () => scope,
    isCurrent: (candidate: unknown) => candidate === scope,
  } as unknown as GatewayPageBinding;
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
    value:
      state.kind === "reference"
        ? { ...state.ref, id: REDACTED_SENTINEL }
        : state.kind === "literal"
          ? REDACTED_SENTINEL
          : undefined,
    disabled: false,
    descriptionId: "credential-help",
  };
  const host = document.createElement("div");
  host.style.cssText = "padding:16px;box-sizing:border-box;width:100%";
  const help = document.createElement("p");
  help.id = field.descriptionId;
  help.textContent = "Provider-owned credential help.";
  document.body.append(help, host);
  const [props, setProps] = createSignal({ field: { ...field }, context: { ...context } });
  mountSolid(() => <PluginCredentialEditor {...props()} descriptor={descriptor} />, {
    container: host,
  });
  const editor = host.querySelector<HTMLElement>("openclaw-plugin-credential-editor")!;
  const update = async () => {
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
    field,
    update,
    ...domProbe(editor),
    get input() {
      return editor.querySelector<HTMLInputElement>("input")!;
    },
    committed: (value: unknown) =>
      vi.waitFor(() => expect(context.onCommit).toHaveBeenCalledWith(path, value)),
  };
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

describe("plugin credential authoring controls", () => {
  it("keeps entered credentials and a reference dialog through same-client reconnects", async () => {
    const { editor, context, field, scope, update, input } = await mount();
    editInput(input, "synthetic-unsaved-key");
    await open(editor, "Use a secret reference");
    const referenceInput = dialogInputs(editor)[1]!;
    editInput(referenceInput, "DRAFT_KEY");
    const gateway = context.gateway;
    Object.assign(gateway, retiredGateway());
    field.disabled = true;
    await update();
    expect([input.value, referenceInput.value]).toEqual(["synthetic-unsaved-key", "DRAFT_KEY"]);
    expect(modal(editor)).not.toBeNull();
    expect(button(editor, "Save").disabled).toBe(true);
    Object.assign(gateway, {
      epoch: 3,
      connected: true,
      capture: () => scope,
      isCurrent: (candidate: unknown) => candidate === scope,
    });
    field.disabled = false;
    await update();
    await vi.waitFor(() => expect(button(editor, "Save").disabled).toBe(false));
    expect([input.value, referenceInput.value]).toEqual(["synthetic-unsaved-key", "DRAFT_KEY"]);
    expect(context.onCommit).not.toHaveBeenCalled();
    context.pluginId = "replacement";
    await update();
    expect(input.value).toBe("");
    expect(modal(editor)).toBeNull();
  });

  it.each(["button", "modal"])(
    "keeps the dialog open for a pending Save via %s dismissal",
    async (dismissal) => {
      const { editor, context } = await mount(reference());
      const pending = createDeferred<boolean>();
      vi.mocked(context.onCommit).mockReturnValue(pending.promise);
      await open(editor);
      button(editor, "Save").click();
      flush();
      if (dismissal === "button") {
        expect(button(editor, "Cancel").disabled).toBe(true);
        button(editor, "Cancel").click();
      } else {
        const event = new CustomEvent("modal-cancel", { bubbles: true, cancelable: true });
        modal(editor)!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
      flush();
      expect(modal(editor)).not.toBeNull();
      pending.resolve(true);
      await vi.waitFor(() => expect(modal(editor)).toBeNull());
    },
  );

  it("preserves an uncommitted literal while an unrelated configuration revision arrives", async () => {
    const { context, scope, update, input, committed } = await mount();
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
    await committed("synthetic-pending-key");
  });

  it("commits when focus leaves for another credential, but not its own reveal button", async () => {
    const first = await mount();
    const second = await mount();
    second.field.path = [...path.slice(0, -1), "otherKey"];
    await second.update();
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

  it("reveals a stored literal only on request without committing it, and clears it on hide", async () => {
    const { editor, scope, context, input } = await mount();
    const reveal = revealButton(editor);
    expect(input.value).toBe("");
    expect(scope.client.request).toHaveBeenCalledWith("plugins.credentials.inspect", {
      pluginId: "example",
      path,
      baseHash: "revision",
    });
    expect(reveal.disabled).toBe(false);
    scope.client.request.mockResolvedValue({
      baseHash: "revision",
      credential: { kind: "literal", value: "synthetic-stored-key" },
    });
    reveal.click();
    await vi.waitFor(() => expect(input.value).toBe("synthetic-stored-key"));
    expect(input.type).toBe("text");
    expect(scope.client.request).toHaveBeenLastCalledWith("plugins.credentials.inspect", {
      pluginId: "example",
      path,
      baseHash: "revision",
      reveal: true,
    });
    input.focus();
    input.blur();
    expect(context.onCommit).not.toHaveBeenCalled();
    revealButton(editor, "Hide").click();
    flush();
    expect(input).toMatchObject({ value: "", type: "password" });
  });

  it.each(["revision", "connection", "permission", "field"])(
    "discards a pending stored-key reveal after %s changes",
    async (change) => {
      const { editor, scope, context, field, update, query } = await mount();
      const pending = createDeferred<unknown>();
      scope.client.request.mockReturnValueOnce(pending.promise).mockResolvedValue({
        baseHash: "new-revision",
        credential: { kind: "literal" },
      });
      revealButton(editor).click();
      await vi.waitFor(() => expect(scope.client.request).toHaveBeenCalledTimes(2));
      if (change === "revision") {
        context.baseHash = "new-revision";
      }
      if (change === "permission") {
        context.canInspect = false;
      }
      if (change === "field") {
        field.path = [...path.slice(0, -1), "otherKey"];
      }
      if (change === "connection") {
        context.gateway = retiredGateway();
      }
      await update();
      pending.resolve({
        baseHash: "revision",
        credential: { kind: "literal", value: "stale-private-key" },
      });
      await pending.promise;
      flush();
      expect(query<HTMLInputElement>("input")?.value).toBe("");
      expect(editor.innerHTML).not.toContain("stale-private-key");
      expect(context.onCommit).not.toHaveBeenCalled();
    },
  );

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

  it.each(["env", "file"] as const)(
    "inspects and edits the exact %s pointer; Cancel never patches",
    async (source) => {
      const id = source === "file" ? "/original/key" : "ORIGINAL_KEY";
      const { editor, context, committed } = await mount(
        reference({ source, provider: "original", id }),
      );
      const { trigger } = await open(editor);
      expect(trigger.getAttribute("aria-describedby")).toBe("credential-help");
      expect(editor.querySelector<HTMLSelectElement>("select")!.value).toBe(source);
      const inputs = dialogInputs(editor);
      expect([...inputs].map((input) => input.value)).toEqual(["original", id]);
      editInput(inputs[0]!, "changed");
      button(editor, "Cancel").click();
      flush();
      expect(context.onCommit).not.toHaveBeenCalled();
      expect(document.activeElement).toBe(trigger);
      await open(editor);
      const next = dialogInputs(editor);
      expect(next[0]!.value).toBe("original");
      editInput(next[0]!, "changed");
      flush();
      button(editor, "Save").click();
      await committed({ source, provider: "changed", id });
    },
  );

  it("retains the reference draft and Cancel on write failure until the existing owner acknowledges retry", async () => {
    const { editor, context, text } = await mount(reference(undefined, true));
    vi.mocked(context.onCommit).mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await open(editor);
    const id = dialogInputs(editor)[1]!;
    editInput(id, "CHANGED_KEY");
    flush();
    button(editor, "Save").click();
    await vi.waitFor(() => expect(text('[role="alert"]')).toContain("could not be saved"));
    expect(id.value).toBe("CHANGED_KEY");
    expect(button(editor, "Cancel")).toBeDefined();
    button(editor, "Save").click();
    await vi.waitFor(() => expect(modal(editor)).toBeNull());
  });

  it("keeps environment fallback inspect-only and validates source-specific identifiers", async () => {
    const { editor, context, query } = await mount({ kind: "environment", envVar: "EXAMPLE_KEY" });
    await open(editor, "View source");
    expect(query(".plugin-credential__dialog input")).toBeNull();
    expect(editor.textContent).toContain("Change that environment variable at its source");
    expect(context.onCommit).not.toHaveBeenCalled();
  });

  it.each([390])("keeps input, signup link and reference dialog within %dpx", async (width) => {
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

  it("rejects stale open-reference edits after config revision changes, and clears inspection on Gateway retirement", async () => {
    const { editor, context, update } = await mount(reference());
    await open(editor);
    context.baseHash = "different";
    await update();
    expect(editor.textContent).toContain("Configuration changed");
    expect(button(editor, "Save").disabled).toBe(true);
    context.gateway = retiredGateway();
    await update();
    expect(modal(editor)).toBeNull();
    expect(context.onCommit).not.toHaveBeenCalled();
  });

  it.each(["plugin", "permission"])(
    "clears private reference metadata after %s identity changes",
    async (change) => {
      const { editor, context, update, query } = await mount(
        reference({ source: "file", provider: "vault", id: "/private/key" }),
      );
      await open(editor);
      if (change === "plugin") {
        context.pluginId = "different";
      } else {
        context.canInspect = false;
      }
      await update();
      expect(modal(editor)).toBeNull();
      expect(query("input")?.value).not.toBe("/private/key");
      expect(context.onCommit).not.toHaveBeenCalled();
    },
  );

  it("lets an administrator inspect a read-only reference without changing it", async () => {
    const { editor, context, field, update } = await mount(
      reference({ source: "env", provider: "default", id: "EXAMPLE_KEY" }),
    );
    field.disabled = true;
    await update();
    await open(editor);
    expect(button(editor, "Save").disabled).toBe(true);
    expect([...dialogInputs(editor)].every((input) => input.disabled)).toBe(true);
    expect(context.onCommit).not.toHaveBeenCalled();
  });
});
