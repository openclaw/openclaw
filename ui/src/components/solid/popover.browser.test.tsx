import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, flush, untrack } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { phase } from "../../test-helpers/solid-menu.tsx";
import { Popover, type PopoverHandle } from "./popover.tsx";

afterEach(cleanup);

describe("Solid native popover", () => {
  it("lets a focused control consume Escape before dismissing the popover", async () => {
    let handle!: PopoverHandle;
    const view = render(() => (
      <Popover id="search-popover" label="Search" ref={(value) => (handle = value)}>
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
      </Popover>
    ));
    flush();
    handle.show();
    expect(document.activeElement).toBe(view.getByRole("textbox"));
    await phase(handle.overlay.surface, "open");
    const input = view.getByRole("textbox") as HTMLInputElement;
    await userEvent.keyboard("{Escape}");
    expect(input.value).toBe("");
    expect(handle.overlay.open).toBe(true);
    await userEvent.keyboard("{Escape}");
    await phase(handle.overlay.surface, "hidden");
  });

  it("vetoes open and light dismissal without losing its input or outside focus", async () => {
    let rejectShow = true;
    let rejectHide = true;
    let handle!: PopoverHandle;
    const view = render(() => (
      <>
        <Popover
          id="details"
          label="Details"
          ref={(value) => (handle = value)}
          onBeforeShow={(event) => {
            if (rejectShow) {
              event.preventDefault();
            }
          }}
          onBeforeHide={(event) => {
            if (rejectHide) {
              event.preventDefault();
            }
          }}
        >
          <input aria-label="Draft" />
        </Popover>
        <button>Outside</button>
      </>
    ));
    flush();
    const surface = handle.overlay.surface;
    await userEvent.click(view.getByRole("button", { name: "Details" }));
    expect(surface.matches(":popover-open")).toBe(false);
    rejectShow = false;
    await userEvent.click(view.getByRole("button", { name: "Details" }));
    await phase(surface, "open");
    const input = view.getByRole("textbox", { name: "Draft" }) as HTMLInputElement;
    await userEvent.fill(input, "Unsaved draft");
    await userEvent.keyboard("{Escape}");
    expect(surface.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("Unsaved draft");
    await userEvent.click(view.getByRole("button", { name: "Outside" }));
    expect(surface.matches(":popover-open")).toBe(true);
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Outside" }));
    rejectHide = false;
    input.focus();
    await userEvent.keyboard("{Escape}");
    await phase(surface, "hidden");
    expect(document.activeElement).toBe(view.getByRole("button", { name: "Details" }));
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
    const [anchor, setAnchor] = createSignal<HTMLElement>(first);
    const [opened, setOpened] = createSignal(false);
    let handle!: PopoverHandle;
    const view = render(() => (
      <Popover
        id="anchored"
        label="Anchored details"
        anchor={anchor()}
        open={opened()}
        ref={(value) => (handle = value)}
      >
        Details
      </Popover>
    ));
    flush();
    try {
      expect(view.queryByRole("button")).toBeNull();
      setOpened(true);
      flush();
      await phase(handle.overlay.surface, "open");
      const anchorName = handle.overlay.surface.style.getPropertyValue("position-anchor");
      expect(first.style.getPropertyValue("anchor-name")).toContain(anchorName);
      setAnchor(second);
      flush();
      expect(first.style.getPropertyValue("anchor-name")).toBe("--existing-anchor");
      expect(second.style.getPropertyValue("anchor-name")).toContain(
        handle.overlay.surface.style.getPropertyValue("position-anchor"),
      );
      setOpened(false);
      flush();
      await phase(handle.overlay.surface, "hidden");
      view.unmount();
      expect(second.style.getPropertyValue("anchor-name")).toBe("");
    } finally {
      first.remove();
      second.remove();
    }
  });

  it("returns vetoed controlled values to the accepted native state", async () => {
    const [opened, setOpened] = createSignal(true);
    let rejectShow = true;
    let rejectHide = true;
    let handle!: PopoverHandle;
    render(() => (
      <Popover
        id="controlled-popover"
        label="Controlled details"
        open={opened()}
        onOpenChange={setOpened}
        onBeforeShow={(event) => {
          if (rejectShow) {
            event.preventDefault();
          }
        }}
        onBeforeHide={(event) => {
          if (rejectHide) {
            event.preventDefault();
          }
        }}
        ref={(value) => (handle = value)}
      >
        Details
      </Popover>
    ));
    flush();
    expect(untrack(opened)).toBe(false);
    expect(handle.overlay.surface.matches(":popover-open")).toBe(false);
    rejectShow = false;
    setOpened(true);
    flush();
    await phase(handle.overlay.surface, "open");
    setOpened(false);
    flush();
    expect(untrack(opened)).toBe(true);
    expect(handle.overlay.surface.matches(":popover-open")).toBe(true);
    rejectHide = false;
    setOpened(false);
    flush();
    await phase(handle.overlay.surface, "hidden");
    expect(untrack(opened)).toBe(false);
  });
});
