import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { registerMenuShortcuts } from "../../../components/menu-shortcuts.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { focusChatComposerFromPrintableKeydown } from "../chat-pane-shared.ts";
import { focusComposerFromChrome } from "./chat-composer-dom.ts";
import { ChatModelPicker } from "./chat-model-picker.tsx";
import { installChatComposerPickerDismissal } from "./chat-picker-overlay.ts";

const container = document.createElement("div");
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  container.replaceChildren();
  container.remove();
});

function mountPicker(optionsReady = true) {
  document.body.append(container);
  dispose = installChatComposerPickerDismissal(document);
  const modelOptions = ["Alpha", "Beta", "Gamma"].map((label) => ({
    label,
    value: (label === "Gamma" ? "other/" : "example/") + label.toLowerCase(),
    commitValue: (label === "Gamma" ? "other/" : "example/") + label.toLowerCase(),
    provider: label === "Gamma" ? "other" : "example",
    isDefault: false,
  }));
  const params = {
    disabled: false,
    modelSelectionLocked: false,
    selectedModelValue: "example/alpha",
    sessionModelPinned: true,
    sessionKey: "main",
    triggerModelLabel: "Alpha",
    modelOptions: optionsReady ? modelOptions : [],
    onModelSelect: vi.fn(async () => {}),
    onOpenChange: vi.fn(),
  };
  let update!: () => void;
  let composer!: HTMLTextAreaElement;
  mountSolid(
    () => {
      const [props, setProps] = createSignal(params);
      update = () => {
        setProps(() => ({ ...params }));
        flush();
      };
      return (
        <div
          class="agent-chat__input"
          onPointerDown={(event) => focusComposerFromChrome(event, true, composer)}
          onClick={(event) => focusComposerFromChrome(event, true, composer)}
          onKeyDown={(event) => focusChatComposerFromPrintableKeydown(container, event, composer)}
        >
          <div class="agent-chat__composer-combobox">
            <textarea ref={(element) => (composer = element)} />
          </div>
          <ChatModelPicker {...props()} />
        </div>
      );
    },
    { container },
  );
  flush();
  const picker = container.querySelector("details")!;
  const trigger = picker.querySelector("summary")!;
  const toggle = async (activate: () => Promise<void>) => {
    const toggled = new Promise<void>((resolve) => {
      picker.addEventListener("toggle", () => resolve(), { once: true });
    });
    await activate();
    await toggled;
    flush();
    await new Promise(requestAnimationFrame);
    if (picker.open) {
      await waitForSolid(() =>
        expect(picker.querySelector(".chat-controls__model-menu")).not.toBeNull(),
      );
    }
  };
  return { params, update, picker, trigger, composer, toggle, modelOptions };
}

it("opens during activation and preserves filter focus and query across catalog rerenders", async () => {
  const { picker, composer, toggle, params, update, trigger } = mountPicker();
  let visibleAtActivation = false;
  container.addEventListener(
    "click",
    () => {
      queueMicrotask(() => {
        visibleAtActivation = container
          .querySelector("[data-anchored-overlay]")!
          .matches(":popover-open");
      });
    },
    { once: true },
  );
  composer.value = "Keep this draft";
  composer.focus();
  await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
  const search = picker.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  expect(visibleAtActivation).toBe(true);
  expect(params.onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
  expect(document.activeElement).toBe(search);
  await userEvent.keyboard("beta");
  expect(search.value).toBe("beta");
  expect(composer.value).toBe("Keep this draft");
  expect(
    container.querySelector<HTMLButtonElement>('[data-chat-model-option="example/alpha"]')!.hidden,
  ).toBe(true);
  expect(
    container.querySelector<HTMLButtonElement>('[data-chat-model-option="example/beta"]')!.hidden,
  ).toBe(false);
  const option = container.querySelector<HTMLButtonElement>(
    '[data-chat-model-option="example/beta"]',
  )!;
  expect(option.checkVisibility()).toBe(true);
  option.focus();
  expect(document.activeElement).toBe(option);
  update();
  await Promise.resolve();
  expect(document.activeElement).toBe(option);
  expect(search.value).toBe("beta");
  trigger.focus();
  await userEvent.keyboard("1");
  expect(params.onModelSelect).toHaveBeenCalledWith("example/beta", "main", undefined);
});

it("clears the active descendant when a catalog refresh removes the filtered choice", async () => {
  const { picker, toggle, params, update } = mountPicker();
  await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
  const search = picker.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
  await userEvent.keyboard("beta");
  const highlighted = container.querySelector<HTMLElement>("[data-chat-model-highlighted]")!;
  expect(highlighted.textContent).toContain("Beta");
  expect(search.getAttribute("aria-activedescendant")).toBe(highlighted.id);
  params.modelOptions = params.modelOptions.filter((option) => option.value !== "example/beta");
  update();
  await Promise.resolve();
  expect(search.value).toBe("beta");
  expect(search.hasAttribute("aria-activedescendant")).toBe(false);
  expect(container.querySelector("[data-chat-model-highlighted]")).toBeNull();
});

it("keeps a disabled picker closed on keyboard activation", async () => {
  const { picker, trigger, params, update } = mountPicker();
  params.disabled = true;
  update();
  trigger.focus();
  await userEvent.keyboard("{Enter}");
  expect(picker.open).toBe(false);
  expect(params.onOpenChange).not.toHaveBeenCalled();
});

it("leaves digit shortcuts to a nested native menu", async () => {
  const { picker, toggle, params, trigger } = mountPicker();
  await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
  const menu = document.createElement("div");
  menu.setAttribute("role", "menu");
  menu.setAttribute("popover", "manual");
  const item = document.createElement("button");
  item.setAttribute("role", "menuitem");
  item.dataset.shortcut = "1";
  item.textContent = "Nested choice";
  menu.append(item);
  const releaseShortcut = registerMenuShortcuts(menu, () => [{ element: item, key: "1" }]);
  picker.querySelector(".chat-controls__model-menu")!.append(menu);
  menu.showPopover();
  item.focus();
  await userEvent.keyboard("1");
  expect(params.onModelSelect).not.toHaveBeenCalled();
  expect(picker.open).toBe(true);
  menu.hidePopover();
  releaseShortcut();
  menu.remove();
  trigger.focus();
  await userEvent.keyboard("1");
  expect(params.onModelSelect).toHaveBeenCalledWith("example/alpha", "main", undefined);
});

it("focuses the filter on keyboard open and reopen, and returns Escape to the trigger", async () => {
  const { picker, trigger, params, toggle } = mountPicker();
  trigger.focus();
  for (const key of ["{Enter}", " "]) {
    await toggle(() => userEvent.keyboard(key));
    const search = picker.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
    expect(document.activeElement).toBe(search);
    await userEvent.keyboard("beta");
    await userEvent.keyboard("{Escape}");
    expect(search.value).toBe("");
    expect(picker.open).toBe(true);
    expect(document.activeElement).toBe(search);
    await toggle(() => userEvent.keyboard("{Escape}"));
    expect(picker.open).toBe(false);
    expect(document.activeElement).toBe(trigger);
  }
  expect(params.onModelSelect).not.toHaveBeenCalled();
});

it.each(["closed", "removed", "focus moved"])(
  "does not autofocus after opening is %s",
  async (state) => {
    const { picker, composer, toggle } = mountPicker();
    picker.addEventListener(
      "toggle",
      () => {
        if (state === "closed") {
          picker.open = false;
        } else if (state === "removed") {
          picker.remove();
        }
        composer.focus();
      },
      { once: true },
    );
    await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
    expect(document.activeElement).toBe(composer);
  },
);

it.each(["open", "closed", "removed", "focus moved"])(
  "honors opening focus when a late catalog arrives and the picker is %s",
  async (state) => {
    const { picker, trigger, composer, toggle, params, modelOptions, update } = mountPicker(false);
    trigger.focus();
    await toggle(() => userEvent.keyboard("{Enter}"));
    expect(picker.querySelector("[data-chat-model-search]")).toBeNull();
    if (state === "closed") {
      await toggle(() => userEvent.keyboard("{Escape}"));
    } else if (state === "removed") {
      picker.remove();
      composer.focus();
    } else if (state === "focus moved") {
      composer.focus();
    }
    const previousFocus = document.activeElement;
    params.modelOptions = modelOptions;
    update();
    await new Promise(requestAnimationFrame);
    const search = picker.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
    expect(search).not.toBeNull();
    expect(document.activeElement).toBe(state === "open" ? search : previousFocus);
  },
);

it.each(["trigger", "Escape", "selection"])(
  "retains provider toggles after closing through %s",
  async (close) => {
    const { picker, trigger, toggle, update, params } = mountPicker();
    await toggle(() => page.getByText("Alpha", { exact: true }).first().click());
    const search = picker.querySelector<HTMLInputElement>("[data-chat-model-search]")!;
    const selectedToggle = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-provider-group="example"] [data-chat-model-provider-toggle]',
    )!;
    const otherToggle = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-provider-group="other"] [data-chat-model-provider-toggle]',
    )!;
    await userEvent.click(selectedToggle);
    await userEvent.click(otherToggle);
    expect(selectedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(otherToggle.getAttribute("aria-expanded")).toBe("true");
    // Search reveals matching rows temporarily without changing group intent.
    await userEvent.click(search);
    await userEvent.keyboard("beta");
    expect(
      picker.querySelector<HTMLButtonElement>('[data-chat-model-option="example/beta"]')!.hidden,
    ).toBe(false);
    update();
    await Promise.resolve();
    if (close === "trigger") {
      await toggle(() => userEvent.click(trigger));
    } else if (close === "Escape") {
      await userEvent.keyboard("{Escape}");
      await toggle(() => userEvent.keyboard("{Escape}"));
    } else {
      await toggle(() => page.getByText("Beta", { exact: true }).click());
      expect(params.onModelSelect).toHaveBeenCalledWith("example/beta", "main", undefined);
    }
    expect(picker.open).toBe(false);
    expect(search.value).toBe("");
    update();
    await toggle(() => userEvent.click(trigger));
    expect(selectedToggle.getAttribute("aria-expanded")).toBe("false");
    expect(otherToggle.getAttribute("aria-expanded")).toBe("true");
    const hidden = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="example/beta"]',
    )!;
    const visible = picker.querySelector<HTMLButtonElement>(
      '[data-chat-model-option="other/gamma"]',
    )!;
    expect(hidden.hidden).toBe(true);
    expect(hidden.checkVisibility()).toBe(false);
    expect(visible.hidden).toBe(false);
    expect(visible.checkVisibility()).toBe(true);
    trigger.focus();
    await toggle(() => userEvent.keyboard("1"));
    expect(params.onModelSelect).toHaveBeenLastCalledWith("other/gamma", "main", undefined);
  },
);
