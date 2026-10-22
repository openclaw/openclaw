import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { baseProps, renderConfigInto } from "./config-view.test-support.tsx";
import type { ConfigProps } from "./view.tsx";
import "../../styles.css";

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}
const attached: HTMLElement[] = [];
function attach(container: HTMLElement) {
  attached.push(document.body.appendChild(container));
}
afterEach(() => attached.splice(0).forEach((container) => container.remove()));
function setup(overrides: Partial<ConfigProps> = {}) {
  const props: ConfigProps = { ...baseProps(), formMode: "raw", ...overrides };
  const container = document.createElement("div");
  const rerender = (patch: Partial<ConfigProps> = {}) => {
    Object.assign(props, patch);
    renderConfigInto(props, container);
  };
  props.onViewStateChange = vi.fn(() => rerender());
  rerender();
  return { props, container, rerender };
}

describe("config raw editing and redaction", () => {
  beforeAll(() => warmJson5().then(() => undefined));

  function text(container: HTMLElement, selector?: string): string {
    const target = selector ? element(container, selector, HTMLElement) : container;
    return target.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function findButton(container: HTMLElement, label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === label,
    );
    if (!button) {
      throw new Error(`Expected button with text "${label}"`);
    }
    return button;
  }

  function element<T extends Element>(
    container: HTMLElement,
    selector: string,
    constructor: new () => T,
  ): T {
    const found = container.querySelector(selector);
    expect(found).toBeInstanceOf(constructor);
    if (!(found instanceof constructor)) {
      throw new Error(`Expected element matching "${selector}"`);
    }
    return found;
  }

  function openDiff(container: HTMLElement) {
    const details = element(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
  }

  function expectDiff(container: HTMLElement, path: string, from: string, to: string) {
    const item = element(container, ".config-diff__item", HTMLElement);
    expect(["path", "from", "to"].map((part) => text(item, `.config-diff__${part}`))).toEqual([
      path,
      from,
      to,
    ]);
  }

  function expectHidden(container: HTMLElement) {
    expect(text(container, ".config-raw-field .settings-count")).toBe("1 secret redacted");
    expect(text(container, ".config-raw-field .callout.info")).toBe(
      "1 sensitive value hidden. Use the reveal button above to edit the raw config.",
    );
    expect(container.querySelector("textarea")).toBeNull();
  }

  it.each(["draft", "equivalent"])("retains the focused raw editor through %s updates", (kind) => {
    const draft = "{a: 2}";
    const { props, container, rerender } = setup({ raw: '{"a":1}', originalRaw: '{"a":1}' });
    props.onRawChange = (next) => {
      props.raw = next;
    };
    rerender();
    attach(container);
    const textarea = element(container, ".config-raw-field textarea", HTMLTextAreaElement);
    textarea.focus();
    textarea.setSelectionRange(3, 6);
    if (kind === "draft") {
      textarea.value = draft;
      textarea.setSelectionRange(3, 6);
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      expect(props.raw).toBe(draft);
    }
    rerender({ ...props });
    expect(element(container, ".config-raw-field textarea", HTMLTextAreaElement)).toBe(textarea);
    expect(document.activeElement).toBe(textarea);
    expect(textarea).toMatchObject({ selectionStart: 3, selectionEnd: 6 });
    if (kind === "draft") {
      rerender({ issues: [] });
      expect(element(container, ".config-raw-field textarea", HTMLTextAreaElement)).toBe(textarea);
      expect(document.activeElement).toBe(textarea);
      expect(textarea).toMatchObject({ selectionStart: 3, selectionEnd: 6, value: draft });
      expect(findButton(container, "Save").disabled).toBe(false);
    }
  });

  it("shows the form-unsafe banner only for populated unsupported paths", () => {
    const schema = object({
      gateway: object({ opaque: { title: "Opaque setting", anyOf: [{ type: "string" }, {}] } }),
      agents: object({ opaque: { anyOf: [{ type: "string" }, {}] } }),
    });

    const empty = setup({
      formMode: "form",
      schema,
      formValue: { gateway: {}, agents: { opaque: "off-scope" } },
      activeSection: "gateway",
    });
    expect(empty.container.querySelector(".config-content-callout .info")).toBeNull();
    expect(findButton(empty.container, "Form").getAttribute("title")).toBe("");

    const onFormModeChange = vi.fn();
    const populated = setup({
      formMode: "form",
      schema,
      formValue: {
        gateway: { opaque: "custom" },
        agents: { opaque: "off-scope" },
      },
      activeSection: "gateway",
      onFormModeChange,
    });
    const banner = element(
      populated.container,
      ".config-content-callout .callout.info",
      HTMLElement,
    );
    expect(text(banner)).toBe(
      "1 setting in this config can only be edited as text: gateway.opaque Open Raw editor",
    );
    expect(banner.querySelector("code")?.textContent).toBe("gateway.opaque");
    expect(findButton(populated.container, "Form").getAttribute("title")).toBe(
      "Form view can't safely edit some fields",
    );
    findButton(banner, "Open Raw editor").click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
    renderConfigInto({ ...populated.props, formMode: "raw" }, populated.container);
    expect(text(populated.container)).not.toContain(
      "1 setting in this config can only be edited as text",
    );
    expect(populated.container.querySelector(".config-raw-field")).not.toBeNull();
  });

  it("keeps explicit open/save/discard controls in raw mode", () => {
    const { container, props } = setup({
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      onOpenFile: vi.fn(),
    });

    expect(findButton(container, "Form").getAttribute("aria-pressed")).toBe("false");
    expect(findButton(container, "Raw").getAttribute("aria-pressed")).toBe("true");
    const actions = element(container, ".config-raw-actions", HTMLElement);
    expect(
      [...actions.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Open", "Discard", "Save"]);
    findButton(actions, "Open").click();
    findButton(actions, "Discard").click();
    findButton(actions, "Save").click();
    expect(props.onOpenFile).toHaveBeenCalledTimes(1);
    expect(props.onRawDiscard).toHaveBeenCalledTimes(1);
    expect(props.onSave).toHaveBeenCalledTimes(1);
    renderConfigInto({ ...props, formMode: "form" }, container);
    expect(container.querySelector(".config-diff")).toBeNull();
    expect(findButton(container, "Form").getAttribute("aria-pressed")).toBe("true");
    expect(findButton(container, "Raw").getAttribute("aria-pressed")).toBe("false");
    findButton(container, "Raw").click();
    expect(props.onFormModeChange).toHaveBeenCalledWith("raw");
  });

  it("pins the raw editor while an unsaved raw draft is authoritative", () => {
    const { container } = setup({
      formMode: "form",
      rawDraftPending: true,
      raw: '{\n  "a": 1\n}\n',
      originalRaw: "{\n}\n",
    });

    expect(container.querySelector(".config-raw-actions")).not.toBeNull();
    const formButton = findButton(container, "Form");
    const rawButton = findButton(container, "Raw");
    expect(formButton.disabled).toBe(true);
    expect(formButton.getAttribute("aria-pressed")).toBe("false");
    expect(rawButton.getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["clean", "saving", "applying"] as const)(
    "locks editor controls while %s",
    (operation) => {
      const { container } = setup({
        formMode: operation === "applying" ? "form" : "raw",
        raw: operation === "clean" ? "{}" : '{ gateway: { mode: "remote" } }',
        originalRaw: "{}",
        saving: operation === "saving",
        applying: operation === "applying",
        schema: object({ gateway: object({ mode: { type: "string" } }) }),
        uiHints: { "gateway.mode": { advanced: false } },
        formValue: { gateway: { mode: "remote" } },
      });
      if (operation === "applying") {
        expect(container.querySelector(".config-content input")?.hasAttribute("disabled")).toBe(
          true,
        );
      } else if (operation === "clean") {
        expect(findButton(container, "Save").disabled).toBe(true);
        expect(findButton(container, "Discard").disabled).toBe(true);
      } else {
        const button = findButton(container, "Saving…");
        expect(button.disabled).toBe(true);
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(button.querySelectorAll(".config-action-spinner")).toHaveLength(1);
        expect(element(container, ".config-raw-field textarea", HTMLTextAreaElement).disabled).toBe(
          true,
        );
      }
    },
  );

  it("keeps sensitive raw config hidden until reveal before editing", () => {
    const onRawChange = vi.fn();
    const { container } = setup({
      raw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      originalRaw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      formValue: { openai: { apiKey: "supersecret" } },
      onRawChange,
    });

    expectHidden(container);

    const revealButton = element(container, ".config-raw-toggle", HTMLButtonElement);
    expect(revealButton.getAttribute("aria-pressed")).toBe("false");
    revealButton.click();

    const textarea = element(container, "textarea", HTMLTextAreaElement);
    expect(textarea.value).toBe('{\n  "openai": { "apiKey": "supersecret" }\n}\n');
    textarea.value = textarea.value.replace("supersecret", "updatedsecret");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRawChange).toHaveBeenCalledWith(textarea.value);
  });

  it("opens raw pending changes without sending a fake raw edit", () => {
    const { container, props, rerender } = setup({
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      formValue: { gateway: { mode: "remote" } },
    });

    const details = element(container, ".config-diff", HTMLDetailsElement);
    expect(details.querySelector(".config-diff__summary span")?.textContent?.trim()).toBe(
      "View pending changes",
    );
    expect(details.querySelector(".config-diff__item")?.textContent?.trim()).toBe(
      "Changes detected (JSON diff not available)",
    );
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    expect(props.onViewStateChange).toHaveBeenCalledTimes(1);
    expect(props.onRawChange).not.toHaveBeenCalled();
    expectDiff(container, "gateway.mode", '"local"', '"remote"');
    props.raw = props.originalRaw;
    props.formValue = { gateway: { mode: "local" } };
    rerender();
    expect(container.querySelector(".config-diff")).toBeNull();
  });

  it.each([
    {
      path: "channels.discord.token.id",
      hint: "channels.discord.token",
      before: { channels: { discord: { token: { id: "TOKEN_BEFORE" } } } },
      after: { channels: { discord: { token: { id: "TOKEN_AFTER" } } } },
    },
    {
      path: "integrations.foo.bar.credential",
      hint: "integrations.*.credential",
      before: { integrations: { "foo.bar": { credential: "TOKEN_BEFORE" } } },
      after: { integrations: { "foo.bar": { credential: "TOKEN_AFTER" } } },
    },
  ])("redacts pending changes under $hint until revealed", ({ path, hint, before, after }) => {
    const { container } = setup({
      raw: JSON.stringify(after),
      originalRaw: JSON.stringify(before),
      uiHints: { [hint]: { sensitive: true, advanced: false } },
      formValue: after,
    });
    openDiff(container);
    const redacted = "[redacted - click reveal to view]";
    expectDiff(container, path, redacted, redacted);
    element(container, ".config-raw-toggle", HTMLButtonElement).click();
    flush();
    expectDiff(container, path, '"TOKEN_BEFORE"', '"TOKEN_AFTER"');
  });

  it("resets raw reveal state when the config context changes", () => {
    const { container, props, rerender } = setup({
      configPath: "/tmp/openclaw-a.json5",
      raw: '{\n  token: "TOKEN_A_AFTER"\n}\n',
      originalRaw: '{\n  token: "TOKEN_A_BEFORE"\n}\n',
      uiHints: { token: { sensitive: true } },
      formValue: { token: "TOKEN_A_AFTER" },
    });
    openDiff(container);
    const revealButton = element(container, ".config-raw-toggle", HTMLButtonElement);
    revealButton.click();
    expectDiff(container, "token", '"TOKEN_A_BEFORE"', '"TOKEN_A_AFTER"');

    props.configPath = "/tmp/openclaw-b.json5";
    props.raw = '{\n  token: "TOKEN_B_AFTER"\n}\n';
    props.originalRaw = '{\n  token: "TOKEN_B_BEFORE"\n}\n';
    props.formValue = { token: "TOKEN_B_AFTER" };
    rerender();

    expectHidden(container);
    const nextDetails = element(container, ".config-diff", HTMLDetailsElement);
    expect(nextDetails.open).toBe(false);

    openDiff(container);
    const redacted = "[redacted - click reveal to view]";
    expectDiff(container, "token", redacted, redacted);
  });

  it("renders structured SecretRef values without stringifying", () => {
    const token = { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" };
    const { container, props, rerender } = setup({
      schema: object({ channels: object({ discord: object({ token: { type: "string" } }) }) }),
      uiHints: { "channels.discord.token": { sensitive: true, advanced: false } },
      formMode: "form",
      formValue: { channels: { discord: { token } } },
    });

    const input = element(container, ".settings-input", HTMLInputElement);
    expect(input).toMatchObject({
      readOnly: true,
      value: "",
      placeholder: "Structured value (SecretRef) - use Raw mode to edit",
    });
    input.value = "[object Object]";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onFormPatch).not.toHaveBeenCalled();

    rerender({ rawAvailable: false, formMode: "raw" });

    expect(findButton(container, "Form").getAttribute("aria-pressed")).toBe("true");
    const rawButton = findButton(container, "Raw");
    expect(rawButton).toMatchObject({
      ariaPressed: "false",
      disabled: true,
      title: "Raw mode unavailable for this snapshot",
    });
    expect(container.querySelector(".config-raw-field")).toBeNull();
    rawButton.click();
    expect(props.onFormModeChange).not.toHaveBeenCalled();

    const rawUnavailableInput = element(container, ".settings-input", HTMLInputElement);
    expect(rawUnavailableInput.placeholder).toBe(
      "Structured value (SecretRef) - edit the config file directly",
    );
  });

  it("keeps malformed non-SecretRef object values editable when raw mode is unavailable", () => {
    const { container, props } = setup({
      rawAvailable: false,
      schema: object({ gateway: object({ mode: { type: "string" } }) }),
      uiHints: { "gateway.mode": { advanced: false } },
      formValue: { gateway: { mode: { malformed: true } } },
    });

    const input = element(container, ".settings-input", HTMLInputElement);
    expect(input).toMatchObject({
      readOnly: false,
      value: '{  "malformed": true}',
      placeholder: "",
    });
    expect(input.value).not.toBe("[object Object]");
    input.value = "local";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(props.onFormPatch).toHaveBeenCalledWith(["gateway", "mode"], "local");
  });
});
