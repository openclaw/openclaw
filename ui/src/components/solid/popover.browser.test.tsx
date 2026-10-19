import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "@solidjs/web";
import { createSignal, createStore, flush } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { phase } from "../../test-helpers/solid-menu.tsx";
import { Popover, type PopoverHandle, type PopoverProps } from "./popover.tsx";

afterEach(cleanup);

function mount(
  props: Partial<PopoverProps> = {},
  content: () => JSX.Element = () => "Details",
  outside?: JSX.Element,
) {
  let handle!: PopoverHandle;
  const view = render(() => (
    <>
      <Popover id="details" label="Details" {...props} ref={(value) => (handle = value)}>
        {content()}
      </Popover>
      {outside}
    </>
  ));
  flush();
  return { view, handle, surface: handle.overlay.surface };
}

const vetoWhen = (rejected: () => boolean) => (event: Event) => {
  if (rejected()) {
    event.preventDefault();
  }
};

describe("Solid native popover", () => {
  it("releases transient content while closed and opens with current data and focus", async () => {
    const [value, setValue] = createSignal("First");
    const { view, handle, surface } = mount(
      {
        lazy: "while-open",
        sameRoot: true,
      },
      () => <input autofocus aria-label="Current value" value={value()} />,
    );
    expect(surface.querySelector("input")).toBeNull();
    setValue("Second");
    flush();
    expect(handle.show()).toBe(true);
    const input = view.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("Second");
    expect(document.activeElement).toBe(input);
    await phase(surface, "open");
    expect(document.querySelectorAll(":popover-open")).toHaveLength(1);
    expect(handle.hide()).toBe(true);
    expect(handle.overlay.phase).toBe("closing");
    expect(input.isConnected).toBe(true);
    expect(handle.show()).toBe(true);
    expect(view.getByRole("textbox")).toBe(input);
    await phase(surface, "open");
    handle.hide();
    await phase(surface, "hidden");
    expect(surface.querySelector("input")).toBeNull();
    setValue("Third");
    flush();
    handle.show();
    expect((view.getByRole("textbox") as HTMLInputElement).value).toBe("Third");
  });

  it("keeps a pinned popover open outside and closes once with Escape", async () => {
    const changes: boolean[] = [];
    const { view, handle, surface } = mount(
      {
        label: "Pinned details",
        dismissOutsidePointer: false,
        dismissOutsideFocus: false,
        onOpenChange: (open) => changes.push(open),
      },
      () => <input aria-label="Pinned draft" />,
      <input aria-label="Outside" />,
    );
    const button = view.getByRole("button", { name: "Pinned details" });
    const outside = view.getByRole("textbox", { name: "Outside" });
    await userEvent.click(button);
    await phase(surface, "open");
    const input = view.getByRole("textbox", { name: "Pinned draft" });
    await userEvent.fill(input, "Unsaved draft");
    await userEvent.click(outside);
    expect(handle.overlay.open).toBe(true);
    expect(document.activeElement).toBe(outside);
    input.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(outside);
    expect(handle.overlay.open).toBe(true);
    expect(changes).toEqual([true]);
    await userEvent.keyboard("{Escape}");
    await phase(surface, "hidden");
    expect(changes).toEqual([true, false]);
    expect(document.activeElement).toBe(button);
  });

  it("lets a focused control consume Escape before dismissing the popover", async () => {
    const { view, handle, surface } = mount({ label: "Search" }, () => (
      <input
        autofocus
        aria-label="Search query"
        value="query"
        onKeyDown={(event) => {
          if (event.key === "Escape" && event.currentTarget.value) {
            event.currentTarget.value = "";
            event.preventDefault();
          }
        }}
      />
    ));
    handle.show();
    expect(document.activeElement).toBe(view.getByRole("textbox"));
    await phase(surface, "open");
    const input = view.getByRole("textbox") as HTMLInputElement;
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("");
    expect(handle.overlay.open).toBe(true);
    await userEvent.keyboard("{Escape}");
    await phase(surface, "hidden");
  });

  it("vetoes open and light dismissal without losing its input or outside focus", async () => {
    let rejectShow = true;
    let rejectHide = true;
    const { view, handle, surface } = mount(
      { onBeforeShow: vetoWhen(() => rejectShow), onBeforeHide: vetoWhen(() => rejectHide) },
      () => <input aria-label="Draft" />,
      <button>Outside</button>,
    );
    const button = view.getByRole("button", { name: "Details" });
    const outside = view.getByRole("button", { name: "Outside" });
    await userEvent.click(button);
    expect(surface.matches(":popover-open")).toBe(false);
    rejectShow = false;
    await userEvent.click(button);
    await phase(surface, "open");
    const input = view.getByRole("textbox", { name: "Draft" }) as HTMLInputElement;
    await userEvent.fill(input, "Unsaved draft");
    await userEvent.keyboard("{Escape}");
    expect(surface.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsaved draft");
    await userEvent.click(outside);
    expect(surface.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(outside);
    rejectHide = false;
    input.focus();
    await userEvent.keyboard("{Escape}");
    await phase(surface, "hidden");
    expect(document.activeElement).toBe(button);
    handle.show();
    await phase(surface, "open");
    expect(view.getByRole("textbox", { name: "Draft" })).toBe(input);
    expect(input.value).toBe("Unsaved draft");
  });

  it("reanchors controlled content and releases the old anchor on disposal", async () => {
    const first = document.createElement("button");
    const second = document.createElement("button");
    document.body.append(first, second);
    first.style.setProperty("anchor-name", "--existing-anchor");
    const [props, update] = createStore({ anchor: first, open: false });
    const { view, surface } = mount(props);
    const set = (next: Partial<typeof props>) => {
      update((current) => ({ ...current, ...next }));
      flush();
    };
    try {
      expect(view.queryByRole("button")).toBeNull();
      set({ open: true });
      await phase(surface, "open");
      const anchorName = surface.style.getPropertyValue("position-anchor");
      expect(first.style.getPropertyValue("anchor-name")).toContain(anchorName);
      set({ anchor: second });
      expect(first.style.getPropertyValue("anchor-name")).toBe("--existing-anchor");
      expect(second.style.getPropertyValue("anchor-name")).toContain(
        surface.style.getPropertyValue("position-anchor"),
      );
      set({ open: false });
      await phase(surface, "hidden");
      view.unmount();
      expect(second.style.getPropertyValue("anchor-name")).toBe("");
    } finally {
      first.remove();
      second.remove();
    }
  });
});
