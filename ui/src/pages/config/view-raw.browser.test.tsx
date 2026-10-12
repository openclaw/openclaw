import { beforeAll, describe, expect, it, vi } from "vitest";
import type { JsonSchema } from "../../components/config-form.shared.ts";
import { warmJson5 } from "../../lib/json5-runtime.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { baseProps, renderConfigInto, renderConfigView } from "./config-view.test-support.tsx";
import type { ConfigProps } from "./view.tsx";
import "../../styles.css";

function object(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties };
}

describe("config raw editing and redaction", () => {
  // Raw diffs use the already-warmed parser, as in the complete view suite.
  beforeAll(async () => {
    await warmJson5();
  });

  function normalizedText(container: HTMLElement): string {
    return container.textContent?.replace(/\s+/g, " ").trim() ?? "";
  }

  function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (btn) => btn.textContent?.trim() === text,
    );
    if (!button) {
      throw new Error(`Expected button with text "${text}"`);
    }
    return button;
  }

  function findButtonContainingText(container: HTMLElement, text: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find((btn) =>
      btn.textContent?.includes(text),
    );
    if (!button) {
      throw new Error(`Expected button containing text "${text}"`);
    }
    return button;
  }

  function required<T extends Element>(
    container: HTMLElement,
    selector: string,
    constructor: new () => T,
  ): T {
    const element = container.querySelector(selector);
    expect(element).toBeInstanceOf(constructor);
    if (!(element instanceof constructor)) {
      throw new Error(`Expected element matching "${selector}"`);
    }
    return element;
  }

  it("shows the form-unsafe banner only for populated unsupported paths", () => {
    const schema = object({
      gateway: object({
        opaque: {
          title: "Opaque setting",
          anyOf: [{ type: "string" }, {}],
        },
      }),
      agents: object({
        opaque: { anyOf: [{ type: "string" }, {}] },
      }),
    });

    const empty = renderConfigView({
      schema,
      formValue: { gateway: {}, agents: { opaque: "off-scope" } },
      activeSection: "gateway",
    });
    expect(empty.container.querySelector(".config-content-callout .info")).toBeNull();
    expect(findButtonByText(empty.container, "Form").getAttribute("title")).toBe("");

    const onFormModeChange = vi.fn();
    const populated = renderConfigView({
      schema,
      formValue: {
        gateway: { opaque: "custom" },
        agents: { opaque: "off-scope" },
      },
      activeSection: "gateway",
      onFormModeChange,
    });
    const banner = required(
      populated.container,
      ".config-content-callout .callout.info",
      HTMLElement,
    );
    expect(normalizedText(banner)).toBe(
      "1 setting in this config can only be edited as text: gateway.opaque Open Raw editor",
    );
    expect(banner.querySelector("code")?.textContent).toBe("gateway.opaque");
    expect(findButtonByText(populated.container, "Form").getAttribute("title")).toBe(
      "Form view can't safely edit some fields",
    );
    findButtonByText(banner, "Open Raw editor").click();
    expect(onFormModeChange).toHaveBeenCalledWith("raw");
    renderConfigInto({ ...populated.props, formMode: "raw" }, populated.container);
    expect(normalizedText(populated.container)).not.toContain(
      "1 setting in this config can only be edited as text",
    );
    expect(populated.container.querySelector(".config-raw-field")).not.toBeNull();
  });

  it("keeps explicit open/save/discard controls in raw mode", () => {
    const onSave = vi.fn();
    const onRawDiscard = vi.fn();
    const onOpenFile = vi.fn();
    const { container, props } = renderConfigView({
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      onSave,
      onRawDiscard,
      onOpenFile,
    });

    expect(findButtonByText(container, "Form").getAttribute("aria-pressed")).toBe("false");
    expect(findButtonByText(container, "Raw").getAttribute("aria-pressed")).toBe("true");
    const actions = required(container, ".config-raw-actions", HTMLElement);
    expect(
      [...actions.querySelectorAll("button")].map((button) => button.textContent?.trim()),
    ).toEqual(["Open", "Discard", "Save"]);
    findButtonContainingText(actions, "Open").click();
    findButtonByText(actions, "Discard").click();
    findButtonByText(actions, "Save").click();
    expect(onOpenFile).toHaveBeenCalledTimes(1);
    expect(onRawDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
    renderConfigInto({ ...props, formMode: "form" }, container);
    expect(container.querySelector(".config-diff")).toBeNull();
    expect(findButtonByText(container, "Form").getAttribute("aria-pressed")).toBe("true");
    expect(findButtonByText(container, "Raw").getAttribute("aria-pressed")).toBe("false");
    findButtonByText(container, "Raw").click();
    expect(props.onFormModeChange).toHaveBeenCalledWith("raw");
  });

  it("pins the raw editor while an unsaved raw draft is authoritative", () => {
    const { container } = renderConfigView({
      formMode: "form",
      rawDraftPending: true,
      raw: '{\n  "a": 1\n}\n',
      originalRaw: "{\n}\n",
    });

    // The capability refuses form submissions until the raw draft is saved or
    // discarded, so the raw actions stay on screen and Form remains gated.
    expect(container.querySelector(".config-raw-actions")).not.toBeNull();
    const formButton = findButtonByText(container, "Form");
    const rawButton = findButtonByText(container, "Raw");
    expect(formButton.disabled).toBe(true);
    expect(formButton.getAttribute("aria-pressed")).toBe("false");
    expect(rawButton.getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["clean", "saving", "applying"] as const)(
    "locks editor controls while %s",
    (operation) => {
      const { container } = renderConfigView({
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
        expect(findButtonByText(container, "Save").disabled).toBe(true);
        expect(findButtonByText(container, "Discard").disabled).toBe(true);
      } else {
        const button = findButtonContainingText(container, "Saving…");
        expect(button.disabled).toBe(true);
        expect(button.getAttribute("aria-busy")).toBe("true");
        expect(button.querySelectorAll(".config-action-spinner")).toHaveLength(1);
        expect(
          required(container, ".config-raw-field textarea", HTMLTextAreaElement).disabled,
        ).toBe(true);
      }
    },
  );

  it("forces Form mode and disables Raw mode when raw text is unavailable", () => {
    const { container, props } = renderConfigView({
      formMode: "raw",
      rawAvailable: false,
      schema: object({
        gateway: object({
          mode: { type: "string" },
        }),
      }),
      formValue: { gateway: { mode: "local" } },
    });

    const formButton = findButtonByText(container, "Form");
    const rawButton = findButtonByText(container, "Raw");
    expect(formButton.getAttribute("aria-pressed")).toBe("true");
    expect(rawButton.getAttribute("aria-pressed")).toBe("false");
    expect(rawButton.disabled).toBe(true);
    expect(rawButton.getAttribute("title")).toBe("Raw mode unavailable for this snapshot");
    expect(container.querySelector(".config-raw-field")).toBeNull();

    rawButton.click();
    expect(props.onFormModeChange).not.toHaveBeenCalled();
  });

  it("keeps sensitive raw config hidden until reveal before editing", () => {
    const onRawChange = vi.fn();
    const { container } = renderConfigView({
      formMode: "raw",
      raw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      originalRaw: '{\n  "openai": { "apiKey": "supersecret" }\n}\n',
      formValue: {
        openai: {
          apiKey: "supersecret",
        },
      },
      onRawChange,
    });

    expect(
      required(container, ".config-raw-field .settings-count", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 secret redacted");
    expect(
      required(container, ".config-raw-field .callout.info", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 sensitive value hidden. Use the reveal button above to edit the raw config.");
    expect(container.querySelector("textarea")).toBeNull();

    const revealButton = required(container, ".config-raw-toggle", HTMLButtonElement);
    expect(revealButton.getAttribute("aria-pressed")).toBe("false");
    revealButton.click();

    const textarea = required(container, "textarea", HTMLTextAreaElement);
    expect(textarea.value).toBe('{\n  "openai": { "apiKey": "supersecret" }\n}\n');
    textarea.value = textarea.value.replace("supersecret", "updatedsecret");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    expect(onRawChange).toHaveBeenCalledWith(textarea.value);
  });

  it("opens raw pending changes without sending a fake raw edit", () => {
    const container = document.createElement("div");
    const onRawChange = vi.fn();
    let updateCount = 0;
    const props: ConfigProps = {
      ...baseProps(),
      formMode: "raw",
      raw: '{\n  gateway: { mode: "remote" }\n}\n',
      originalRaw: '{\n  gateway: { mode: "local" }\n}\n',
      formValue: {
        gateway: {
          mode: "remote",
        },
      },
      onRawChange,
    };
    const rerender = () =>
      renderConfigInto(
        {
          ...props,
          onViewStateChange: () => {
            updateCount += 1;
            rerender();
          },
        },
        container,
      );
    rerender();

    const details = required(container, ".config-diff", HTMLDetailsElement);
    expect(details.querySelector(".config-diff__summary span")?.textContent?.trim()).toBe(
      "View pending changes",
    );
    expect(details.querySelector(".config-diff__item")?.textContent?.trim()).toBe(
      "Changes detected (JSON diff not available)",
    );
    details.open = true;
    details.dispatchEvent(new Event("toggle"));

    expect(updateCount).toBe(1);
    expect(onRawChange).not.toHaveBeenCalled();
    const item = required(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe("gateway.mode");
    expect(item.querySelector(".config-diff__from")?.textContent?.trim()).toBe('"local"');
    expect(item.querySelector(".config-diff__to")?.textContent?.trim()).toBe('"remote"');
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
    const { container } = renderConfigView({
      formMode: "raw",
      raw: JSON.stringify(after),
      originalRaw: JSON.stringify(before),
      uiHints: { [hint]: { sensitive: true, advanced: false } },
      formValue: after,
    });
    const details = required(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const item = required(container, ".config-diff__item", HTMLElement);
    expect(item.querySelector(".config-diff__path")?.textContent?.trim()).toBe(path);
    for (const selector of [".config-diff__from", ".config-diff__to"]) {
      expect(item.querySelector(selector)?.textContent?.trim()).toBe(
        "[redacted - click reveal to view]",
      );
    }
    required(container, ".config-raw-toggle", HTMLButtonElement).click();
    flush();
    const revealedItem = required(container, ".config-diff__item", HTMLElement);
    expect(revealedItem.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      '"TOKEN_BEFORE"',
    );
    expect(revealedItem.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      '"TOKEN_AFTER"',
    );
  });

  it("resets raw reveal state when the config context changes", () => {
    const container = document.createElement("div");
    const props: ConfigProps = {
      ...baseProps(),
      configPath: "/tmp/openclaw-a.json5",
      formMode: "raw",
      raw: '{\n  token: "TOKEN_A_AFTER"\n}\n',
      originalRaw: '{\n  token: "TOKEN_A_BEFORE"\n}\n',
      uiHints: {
        token: { sensitive: true },
      },
      formValue: {
        token: "TOKEN_A_AFTER",
      },
    };
    const rerender = () =>
      renderConfigInto(
        {
          ...props,
          onViewStateChange: rerender,
        },
        container,
      );
    rerender();

    const details = required(container, ".config-diff", HTMLDetailsElement);
    details.open = true;
    details.dispatchEvent(new Event("toggle"));
    const revealButton = required(container, ".config-raw-toggle", HTMLButtonElement);
    revealButton.click();
    const revealedItem = required(container, ".config-diff__item", HTMLElement);
    expect(revealedItem.querySelector(".config-diff__path")?.textContent?.trim()).toBe("token");
    expect(revealedItem.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      '"TOKEN_A_BEFORE"',
    );
    expect(revealedItem.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      '"TOKEN_A_AFTER"',
    );

    props.configPath = "/tmp/openclaw-b.json5";
    props.raw = '{\n  token: "TOKEN_B_AFTER"\n}\n';
    props.originalRaw = '{\n  token: "TOKEN_B_BEFORE"\n}\n';
    props.formValue = {
      token: "TOKEN_B_AFTER",
    };
    rerender();

    expect(
      required(container, ".config-raw-field .settings-count", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 secret redacted");
    expect(
      required(container, ".config-raw-field .callout.info", HTMLElement)
        .textContent?.replace(/\s+/g, " ")
        .trim(),
    ).toBe("1 sensitive value hidden. Use the reveal button above to edit the raw config.");
    expect(container.querySelector("textarea")).toBeNull();
    const nextDetails = required(container, ".config-diff", HTMLDetailsElement);
    expect(nextDetails.open).toBe(false);

    nextDetails.open = true;
    nextDetails.dispatchEvent(new Event("toggle"));
    const redactedItem = required(container, ".config-diff__item", HTMLElement);
    expect(redactedItem.querySelector(".config-diff__path")?.textContent?.trim()).toBe("token");
    expect(redactedItem.querySelector(".config-diff__from")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
    expect(redactedItem.querySelector(".config-diff__to")?.textContent?.trim()).toBe(
      "[redacted - click reveal to view]",
    );
  });

  it("renders structured SecretRef values without stringifying", () => {
    const secretRefSchema = object({
      channels: object({
        discord: object({
          token: { type: "string" as const },
        }),
      }),
    });
    const secretRefValue = {
      channels: {
        discord: {
          token: { source: "env", provider: "default", id: "__OPENCLAW_REDACTED__" },
        },
      },
    };
    const { container, props } = renderConfigView({
      schema: secretRefSchema,
      uiHints: {
        "channels.discord.token": { sensitive: true, advanced: false },
      },
      formMode: "form",
      formValue: secretRefValue,
    });

    const input = required(container, ".settings-input", HTMLInputElement);
    expect(input.readOnly).toBe(true);
    expect(input.value).toBe("");
    expect(input.placeholder).toBe("Structured value (SecretRef) - use Raw mode to edit");
    input.value = "[object Object]";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    expect(props.onFormPatch).not.toHaveBeenCalled();

    renderConfigInto({ ...props, rawAvailable: false, formMode: "raw" }, container);

    const rawUnavailableInput = required(container, ".settings-input", HTMLInputElement);
    expect(rawUnavailableInput.placeholder).toBe(
      "Structured value (SecretRef) - edit the config file directly",
    );
  });

  it("keeps malformed non-SecretRef object values editable when raw mode is unavailable", () => {
    const { container, props } = renderConfigView({
      rawAvailable: false,
      formMode: "raw",
      schema: object({
        gateway: object({
          mode: { type: "string" },
        }),
      }),
      uiHints: { "gateway.mode": { advanced: false } },
      formValue: {
        gateway: {
          mode: { malformed: true },
        },
      },
    });

    const input = container.querySelector<HTMLInputElement>(".settings-input");
    expect(input).toBeInstanceOf(HTMLInputElement);
    expect(input?.readOnly).toBe(false);
    expect(input?.value).toBe('{  "malformed": true}');
    expect(input?.value).not.toBe("[object Object]");
    expect(input?.placeholder).toBe("");

    if (!input) {
      return;
    }
    input.value = "local";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(props.onFormPatch).toHaveBeenCalledWith(["gateway", "mode"], "local");
  });
});
