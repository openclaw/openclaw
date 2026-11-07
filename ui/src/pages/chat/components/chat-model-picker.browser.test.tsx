import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { registerMenuShortcuts } from "../../../components/menu-shortcuts.ts";
import { mountSolid } from "../../../test-helpers/mount-solid.ts";
import { flush, waitForSolid } from "../../../test-helpers/solid-settle.ts";
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
      if (params.modelOptions.length) {
        await waitForSolid(() =>
          expect(picker.querySelector("[data-chat-model-option]")).not.toBeNull(),
        );
      }
    }
  };
  const open = () => toggle(() => page.getByText("Alpha", { exact: true }).first().click());
  return { params, update, picker, trigger, composer, toggle, modelOptions, open };
}

it("leaves touch pointerdown uncancelled for native model-picker activation", () => {
  const { composer, trigger } = mountPicker();
  composer.value = "Keep this draft";
  composer.focus();
  const touch = new PointerEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
    composed: true,
    button: 0,
    pointerType: "touch",
  });

  // Native tap activation needs browser proof; this guards its uncancelled first event.
  trigger.dispatchEvent(touch);

  expect(touch.defaultPrevented).toBe(false);
  expect(composer.value).toBe("Keep this draft");
});

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
  // Windowed results publish after the sheet's layout measurement.
  await waitForSolid(() => expect(option("example/beta")).toMatchObject({ hidden: false }));
  const beta = option("example/beta");
  expect(beta.checkVisibility()).toBe(true);
  beta.focus();
  expect(document.activeElement).toBe(beta);
  params.modelOptions = params.modelOptions.toReversed();
  params.selectedModelValue = "other/gamma";
  update();
  await Promise.resolve();
  expect(document.activeElement).toBe(beta);
  expect(option("example/beta")).toBe(beta);
  expect(search.value).toBe("beta");
  expect(
    [...container.querySelectorAll<HTMLElement>("[data-chat-model-provider-group]")].map(
      (group) => group.dataset.chatModelProviderGroup,
    ),
  ).toEqual(["other", "example"]);
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

it("preserves composition ownership and ordinary model-search keyboard behavior", async () => {
  const { picker, trigger, params, update, open, toggle } = mountPicker();
  const onModelSelect = vi.fn(async () => {});
  params.onModelSelect = onModelSelect;
  params.modelOptions = [
    modelOption("example", "alpha", { label: "Alpha" }),
    modelOption("other", "gamma", { label: "Gamma" }),
    modelOption("other", "delta", { label: "Delta" }),
  ];
  update();
  for (const composition of ["active", "keyCode229", "none"]) {
    for (const key of ["Enter", "Escape", "ArrowDown", "ArrowUp"]) {
      const label = `${composition} ${key}`;
      await open();
      await vi.waitFor(() =>
        expect(picker.querySelectorAll("[data-chat-model-option]"), label).toHaveLength(1),
      );
      const other = picker.querySelector<HTMLButtonElement>(
        '[data-chat-model-provider-toggle="other"]',
      )!;
      if (key.startsWith("Arrow")) {
        await userEvent.click(other);
      }
      const search = getSearch();
      const query = key.startsWith("Arrow") ? "" : "gamma";
      if (query) {
        search.value = query;
        search.dispatchEvent(new InputEvent("input", { bubbles: true }));
        flush();
      }
      await vi.waitFor(() =>
        expect(picker.querySelectorAll("[data-chat-model-option]"), label).toHaveLength(
          key.startsWith("Arrow") ? 2 : 1,
        ),
      );
      search.focus();
      const highlighted = search.getAttribute("aria-activedescendant");
      expect(highlighted, label).toBeTruthy();
      // Exercise browser event ownership, not a native OS IME candidate window.
      const event = new KeyboardEvent("keydown", {
        key,
        isComposing: composition === "active",
        keyCode: composition === "keyCode229" ? 229 : 0,
        bubbles: true,
        cancelable: true,
        composed: true,
      });
      onModelSelect.mockClear();
      const dispatch = async () => {
        search.dispatchEvent(event);
        flush();
      };
      if (composition === "none" && key === "Enter") {
        await toggle(dispatch);
      } else {
        await dispatch();
      }
      if (composition !== "none") {
        expect.soft(event.defaultPrevented, label).toBe(false);
        expect.soft(picker.open, label).toBe(true);
        expect.soft(search.value, label).toBe(query);
        expect.soft(search.getAttribute("aria-activedescendant"), label).toBe(highlighted);
        expect.soft(onModelSelect, label).not.toHaveBeenCalled();
      } else {
        expect(event.defaultPrevented, label).toBe(true);
        if (key === "Enter") {
          expect(onModelSelect, label).toHaveBeenCalledExactlyOnceWith(
            "other/gamma",
            "main",
            undefined,
          );
          expect(picker.open, label).toBe(false);
        } else {
          expect(picker.open, label).toBe(true);
          expect(onModelSelect, label).not.toHaveBeenCalled();
          if (key === "Escape") {
            expect(search.value, label).toBe("");
            await toggle(() => userEvent.keyboard("{Escape}"));
            expect(picker.open, label).toBe(false);
          } else {
            expect(search.getAttribute("aria-activedescendant"), label).not.toBe(highlighted);
          }
        }
      }
      if (picker.open) {
        search.value = "";
        search.dispatchEvent(new InputEvent("input", { bubbles: true }));
        flush();
        if (other.ariaSelected === "true") {
          await userEvent.click(
            picker.querySelector<HTMLButtonElement>('[data-chat-model-provider-toggle="example"]')!,
          );
        }
        await toggle(() => userEvent.click(trigger));
        expect(picker.open, label).toBe(false);
      }
    }
  }
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
      picker.querySelector<HTMLButtonElement>(`[data-chat-model-provider-toggle="${provider}"]`)!;
    const selectedToggle = providerToggle("example"),
      otherToggle = providerToggle("other");
    const expectExpanded = () =>
      expect([selectedToggle.ariaSelected, otherToggle.ariaSelected]).toEqual(["false", "true"]);
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
    const heading = container.querySelector<HTMLElement>("[data-chat-model-heading]")!;
    expect(heading.getBoundingClientRect().top).toBe(clip.top);
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

it("keeps the complete model panel above the composer", async () => {
  await page.viewport(1280, 900);
  container.style.cssText =
    "position:fixed;bottom:16px;right:16px;width:min(600px, calc(100vw - 32px))";
  const { toggle, trigger, picker, composer } = mountPicker();
  try {
    await toggle(async () => trigger.click());
    const menu = picker.querySelector<HTMLElement>(".chat-controls__model-menu")!;
    const surface = picker.querySelector<HTMLElement>(".chat-picker-overlay")!;
    await vi.waitFor(() => {
      const panel = menu.getBoundingClientRect();
      const bounds = surface.getBoundingClientRect();
      expect(bounds.bottom).toBeLessThanOrEqual(
        composer.parentElement!.parentElement!.getBoundingClientRect().top - 8,
      );
      expect(panel.bottom).toBeLessThanOrEqual(bounds.bottom);
      expect(menu.scrollHeight).toBeLessThanOrEqual(menu.clientHeight);
      expect(option("example/beta").getBoundingClientRect().bottom).toBeLessThanOrEqual(
        panel.bottom - 8,
      );
    });
    const beta = option("example/beta");
    const background = getComputedStyle(beta).backgroundColor;
    const highlighted = getSearch().getAttribute("aria-activedescendant");
    await page.getByText("Beta", { exact: true }).hover();
    expect(getComputedStyle(beta).backgroundColor).toBe(background);
    expect(getSearch().getAttribute("aria-activedescendant")).toBe(highlighted);
  } finally {
    container.removeAttribute("style");
  }
});

it("places provider recovery below the disabled model rows", async () => {
  const { params, update, open, picker } = mountPicker();
  params.modelOptions = params.modelOptions.map((entry) => ({
    ...entry,
    disabled: true,
    unavailableReason: "auth-failed",
  }));
  params.onModelSetup = vi.fn();
  update();
  await open();
  await vi.waitFor(() => {
    const state = picker.querySelector<HTMLElement>("[data-chat-model-auth-state]")!;
    const rows = [...picker.querySelectorAll<HTMLElement>("[data-chat-model-option]")];
    expect(state.getBoundingClientRect().top).toBeGreaterThanOrEqual(
      Math.max(...rows.map((row) => row.getBoundingClientRect().bottom)),
    );
    expect(state.querySelector("button")!.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      picker.querySelector(".chat-picker-overlay")!.getBoundingClientRect().bottom - 8,
    );
  });
});
