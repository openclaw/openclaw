import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { registerMenuShortcuts } from "../../../components/menu-shortcuts.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush } from "../../../test-helpers/solid-settle.ts";
import { focusChatComposerFromKeydown } from "../chat-pane-shared.ts";
import "../../../styles/base.css";
import "../../../styles/chat/composer.css";
import { focusComposerFromChrome } from "./chat-composer-dom.ts";
import {
  modelControlSelector,
  modelOption,
  modelPickerProps,
  waitForModelMenu,
} from "./chat-model-picker.test-support.tsx";
import { ChatModelPicker } from "./chat-model-picker.tsx";
import { installChatComposerPickerDismissal } from "./chat-picker-overlay.ts";

const container = document.createElement("div");
const getSearch = () => container.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
const option = (value: string) =>
  container.querySelector<HTMLButtonElement>(modelControlSelector("option", value))!;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  container.replaceChildren();
  container.remove();
});

function mountPicker(optionsReady = true) {
  document.body.append(container);
  dispose = installChatComposerPickerDismissal(document);
  const modelOptions = ["Alpha", "Beta", "Gamma"].map((label) =>
    modelOption(label === "Gamma" ? "other" : "example", label.toLowerCase(), { label }),
  );
  const params = modelPickerProps({
    selectedModelValue: "example/alpha",
    triggerModelLabel: "Alpha",
    modelOptions: optionsReady ? modelOptions : [],
    onOpenChange: vi.fn(),
  });
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
          onKeyDown={(event) => focusChatComposerFromKeydown(container, event, composer)}
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
      await waitForModelMenu(picker);
    }
  };
  const open = () => toggle(() => page.getByText("Alpha", { exact: true }).first().click());
  return { params, update, picker, trigger, composer, toggle, modelOptions, open };
}

it("opens during activation and preserves filter focus and query across catalog rerenders", async () => {
  const { composer, open, params, update, trigger } = mountPicker();
  expect(container.querySelector<HTMLElement>(modelControlSelector("option"))).toBeNull();
  expect(container.querySelector(".chat-controls__model-menu")).toBeNull();
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
  await open();
  const search = getSearch();
  expect(visibleAtActivation).toBe(true);
  expect(params.onOpenChange).toHaveBeenCalledExactlyOnceWith(true);
  expect(document.activeElement).toBe(search);
  await userEvent.keyboard("beta");
  expect(search.value).toBe("beta");
  expect(composer.value).toBe("Keep this draft");
  expect(option("example/alpha")).toBeNull();
  const beta = option("example/beta");
  expect(beta).toMatchObject({ hidden: false });
  expect(beta.checkVisibility()).toBe(true);
  beta.focus();
  expect(document.activeElement).toBe(beta);
  update();
  await Promise.resolve();
  expect(document.activeElement).toBe(beta);
  expect(search.value).toBe("beta");
  trigger.focus();
  await userEvent.keyboard("1");
  expect(params.onModelSelect).toHaveBeenCalledWith("example/beta", "main", undefined);
});

it("clears the active descendant when a catalog refresh removes the filtered choice", async () => {
  const { open, params, update } = mountPicker();
  await open();
  const search = getSearch();
  await userEvent.keyboard("beta");
  const highlighted = container.querySelector<HTMLElement>(modelControlSelector("highlighted"))!;
  expect(highlighted.textContent).toContain("Beta");
  expect(search.getAttribute("aria-activedescendant")).toBe(highlighted.id);
  params.modelOptions = params.modelOptions.filter((row) => row.value !== "example/beta");
  update();
  await Promise.resolve();
  expect(search.value).toBe("beta");
  expect(search.hasAttribute("aria-activedescendant")).toBe(false);
  expect(container.querySelector<HTMLElement>(modelControlSelector("highlighted"))).toBeNull();
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
  const { picker, open, params, trigger } = mountPicker();
  await open();
  const menu = document.createElement("div");
  menu.role = "menu";
  menu.popover = "manual";
  menu.innerHTML = '<button role="menuitem" data-shortcut="1">Nested choice</button>';
  const item = menu.querySelector("button")!;
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
    const search = picker.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
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

it.each([
  [true, "closed"],
  [true, "removed"],
  [true, "focus moved"],
  [false, "open"],
  [false, "closed"],
  [false, "removed"],
  [false, "focus moved"],
] as const)("guards autofocus: ready=%s, picker=%s", async (ready, state) => {
  const { picker, trigger, composer, toggle, open, params, modelOptions, update } =
    mountPicker(ready);
  const interrupt = () => {
    if (state === "closed") {
      picker.open = false;
    } else if (state === "removed") {
      picker.remove();
    }
    composer.focus();
  };
  if (ready) {
    picker.addEventListener("toggle", interrupt, { once: true });
    await open();
    expect(document.activeElement).toBe(composer);
    return;
  }
  trigger.focus();
  await toggle(() => userEvent.keyboard("{Enter}"));
  expect(picker.querySelector<HTMLElement>(modelControlSelector("search"))).toBeNull();
  if (state === "closed") {
    await toggle(() => userEvent.keyboard("{Escape}"));
  } else if (state !== "open") {
    interrupt();
  }
  const previousFocus = document.activeElement;
  params.modelOptions = modelOptions;
  update();
  await new Promise(requestAnimationFrame);
  const search = picker.querySelector<HTMLInputElement>(modelControlSelector("search"))!;
  expect(search).not.toBeNull();
  expect(document.activeElement).toBe(state === "open" ? search : previousFocus);
});

it.each(["trigger", "Escape", "selection"])(
  "retains provider toggles after closing through %s",
  async (close) => {
    const { picker, trigger, toggle, open, update, params } = mountPicker();
    await open();
    const search = getSearch();
    const providerToggle = (provider: string) =>
      picker.querySelector<HTMLButtonElement>(
        `[data-chat-model-provider-group="${provider}"] [data-chat-model-provider-toggle]`,
      )!;
    const selectedToggle = providerToggle("example"),
      otherToggle = providerToggle("other");
    const expectExpanded = () =>
      expect([selectedToggle.ariaExpanded, otherToggle.ariaExpanded]).toEqual(["false", "true"]);
    await userEvent.click(selectedToggle);
    await userEvent.click(otherToggle);
    expectExpanded();
    // Search reveals matching rows temporarily without changing group intent.
    await userEvent.click(search);
    await userEvent.keyboard("beta");
    expect(option("example/beta").hidden).toBe(false);
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
    expect(option("example/beta")).toBeNull();
    expectExpanded();
    await vi.waitFor(() => {
      const visible = option("other/gamma");
      expect(visible).toMatchObject({ hidden: false });
      expect(visible.checkVisibility()).toBe(true);
    });
    trigger.focus();
    await toggle(() => userEvent.keyboard("1"));
    expect(params.onModelSelect).toHaveBeenLastCalledWith("other/gamma", "main", undefined);
  },
);

it("windows a large catalog while keeping keyboard choices and accessible positions live", async () => {
  const { params, update, open } = mountPicker();
  params.modelOptions = Array.from({ length: 1000 }, (_, index) =>
    modelOption("example", `model-${index}`, { label: `Model ${String(index).padStart(4, "0")}` }),
  );
  params.selectedModelValue = "example/model-0";
  update();
  await open();
  const rows = () => [...container.querySelectorAll<HTMLButtonElement>("[data-chat-model-option]")];
  expect(rows()).toHaveLength(9);
  // Shortcut rows are pinned before the viewport's remaining rows are measured.
  const more = await vi.waitFor(() => {
    const button = container.querySelector<HTMLButtonElement>("[data-chat-model-more-toggle]");
    expect(button?.checkVisibility()).toBe(true);
    return button!;
  });
  more.click();
  flush();
  const search = getSearch();
  search.focus();
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
  flush();
  await vi.waitFor(() => {
    const active = document.getElementById(search.getAttribute("aria-activedescendant")!);
    expect(active?.getAttribute("data-chat-model-option")).toBe("example/model-999");
    expect(active?.getAttribute("aria-posinset")).toBe("991");
    expect(active?.getAttribute("aria-setsize")).toBe("991");
    const viewport = container.querySelector<HTMLElement>("[data-chat-model-window]")!;
    expect(viewport.scrollTop).toBeGreaterThan(0);
    const bounds = active!.getBoundingClientRect();
    const clip = viewport.getBoundingClientRect();
    expect(bounds.top).toBeGreaterThanOrEqual(clip.top);
    expect(bounds.bottom).toBeLessThanOrEqual(clip.bottom);
    expect(rows().length).toBeLessThan(40);
  });
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  flush();
  await vi.waitFor(() =>
    expect(
      document
        .getElementById(search.getAttribute("aria-activedescendant")!)
        ?.getAttribute("data-chat-model-option"),
    ).toBe("example/model-0"),
  );
  search.value = "Model 0999";
  search.dispatchEvent(new InputEvent("input", { bubbles: true }));
  flush();
  await vi.waitFor(() =>
    expect(rows().map((row) => row.dataset.chatModelOption)).toEqual(["example/model-999"]),
  );
  expect(rows()[0]?.getAttribute("aria-setsize")).toBe("1");
  expect(search.getAttribute("aria-activedescendant")).toBe(rows()[0]?.id);
  search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(params.onModelSelect).toHaveBeenCalledWith("example/model-999", "main", undefined);
});
