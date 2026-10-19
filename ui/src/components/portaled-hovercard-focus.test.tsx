/* @vitest-environment jsdom */
import { createSignal, flush, For } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { MarkdownDomReconciler } from "../lib/markdown-dom-reconciler.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  controlsForHovercard,
  createHovercardControlRef,
  HovercardControlsContext,
} from "./portaled-hovercard-focus.ts";
import { SessionHovercard } from "./session-hovercard-solid.tsx";
import { CopyButton } from "./solid/copy-button.tsx";
import { settleTooltip } from "./tooltip.test-support.ts";

function card() {
  const element = document.body.appendChild(document.createElement("div"));
  onTestFinished(() => element.remove());
  return element;
}

describe("hovercard controls", () => {
  it("follows committed row order and excludes controls outside the active tab sequence", () => {
    const container = card();
    const controls = controlsForHovercard(container);
    const [items, setItems] = createSignal(["first", "second"]);
    const view = mountSolid(
      () => (
        <HovercardControlsContext value={controls}>
          <For each={items()}>
            {(item) => <button ref={createHovercardControlRef()}>{item}</button>}
          </For>
          <button>Unregistered</button>
          <button ref={createHovercardControlRef()} disabled>
            Disabled
          </button>
          <a ref={createHovercardControlRef()} href="#decorative" tabindex="-1">
            Decorative
          </a>
          <openclaw-tooltip>
            <button ref={createHovercardControlRef()}>Inspect</button>
            <div slot="content">
              <a ref={createHovercardControlRef()} href="#detail">
                Detail
              </a>
            </div>
          </openclaw-tooltip>
        </HovercardControlsContext>
      ),
      { container },
    );
    onTestFinished(view.unmount);

    expect(controls.read().map((element) => element.textContent)).toEqual([
      "first",
      "second",
      "Inspect",
    ]);
    const first = view.getByRole("button", { name: "first" });
    const second = view.getByRole("button", { name: "second" });
    setItems(["second", "first"]);
    flush();
    expect(controls.read().slice(0, 2)).toEqual([second, first]);

    const tooltip = container.querySelector("openclaw-tooltip")!;
    tooltip.setAttribute("open", "");
    expect(controls.read().map((element) => element.textContent)).toEqual([
      "second",
      "first",
      "Inspect",
      "Detail",
    ]);
    first.setAttribute("disabled", "");
    expect(controls.read().map((element) => element.textContent)).toEqual([
      "second",
      "Inspect",
      "Detail",
    ]);
    tooltip.removeAttribute("open");
    expect(controls.read().map((element) => element.textContent)).toEqual(["second", "Inspect"]);
  });

  it("registers session participant inspection and native facepile links through their owning bridge", async () => {
    const container = card();
    const controls = controlsForHovercard(container);
    const view = mountSolid(
      () => (
        <HovercardControlsContext value={controls}>
          <SessionHovercard
            row={{
              label: "Review session",
              hasActiveRun: false,
              participants: [
                { identity: { type: "profile", id: "alice" }, label: "Alice" },
                { identity: { type: "profile", id: "mira" }, label: "Mira" },
                { identity: { type: "profile", id: "riley" }, label: "Riley" },
              ],
            }}
            personActivity={{ basePath: "", navigate: vi.fn() }}
          />
        </HovercardControlsContext>
      ),
      { container },
    );
    onTestFinished(view.unmount);

    const tooltip = container.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>(
      "openclaw-tooltip.session-hovercard__participants-tooltip",
    )!;
    await settleTooltip(tooltip);
    const name = container.querySelector<HTMLAnchorElement>(
      ".session-hovercard__attribution-name",
    )!;
    const trigger = tooltip.querySelector<HTMLButtonElement>(
      ".session-hovercard__attribution-others",
    )!;
    const miraDetail = tooltip.querySelector<HTMLAnchorElement>('a[href="/activity/mira"]')!;
    const rileyDetail = tooltip.querySelector<HTMLAnchorElement>('a[href="/activity/riley"]')!;
    const facepile = container.querySelector("openclaw-viewer-facepile")!;
    const miraAvatar = facepile.querySelector<HTMLAnchorElement>('a[href="/activity/mira"]')!;
    const rileyAvatar = facepile.querySelector<HTMLAnchorElement>('a[href="/activity/riley"]')!;
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(controls.read()).toEqual([name, trigger, miraAvatar, rileyAvatar]);

    trigger.click();
    await settleTooltip(tooltip);
    expect(tooltip.hasAttribute("open")).toBe(true);
    expect(controls.read()).toEqual([
      name,
      trigger,
      miraDetail,
      rileyDetail,
      miraAvatar,
      rileyAvatar,
    ]);

    trigger.click();
    await settleTooltip(tooltip);
    expect(tooltip.hasAttribute("open")).toBe(false);
    expect(controls.read()).toEqual([name, trigger, miraAvatar, rileyAvatar]);
    miraAvatar.focus();
    expect(document.activeElement).toBe(miraAvatar);

    view.unmount();
    // Reconnecting the old controls distinguishes release from disconnected-node filtering.
    container.append(name, trigger, miraDetail, rileyDetail, miraAvatar, rileyAvatar);
    expect(controls.read()).toEqual([]);
  });

  it("retires a payload-replaced Copy button without keeping its old control registered", () => {
    const container = card();
    const controls = controlsForHovercard(container);
    const [text, setText] = createSignal("first");
    const view = mountSolid(
      () => (
        <HovercardControlsContext value={controls}>
          <CopyButton text={text()} idleLabel="Copy value" />
        </HovercardControlsContext>
      ),
      { container },
    );
    onTestFinished(view.unmount);
    const original = view.getByRole("button", { name: "Copy value" });
    expect(controls.read()).toEqual([original]);

    setText("second");
    flush();
    const replacement = view.getByRole("button", { name: "Copy value" });
    expect(replacement).not.toBe(original);
    // A detached old control must be released, rather than merely filtered out.
    container.append(original);
    expect(controls.read()).toEqual([replacement]);

    view.unmount();
    container.append(replacement);
    expect(controls.read()).toEqual([]);
  });

  it("reads only the current Markdown island and releases retired sources independently per card", () => {
    const container = card();
    const before = container.appendChild(document.createElement("button"));
    before.textContent = "Outside island";
    const markdown = new MarkdownDomReconciler(container);
    onTestFinished(() => markdown.dispose());
    const controls = controlsForHovercard(container);
    const read = vi.fn(() => markdown.focusableControls());
    const release = controls.registerSource(read);
    const other = controlsForHovercard(card());
    expect(controlsForHovercard(container)).toBe(controls);

    markdown.updateHtml('<p><a href="#old">Old</a></p>');
    expect(controls.read().map((element) => element.textContent)).toEqual(["Old"]);
    markdown.updateHtml('<details><summary>More</summary><a href="#new">New</a></details>');
    expect(controls.read().map((element) => element.textContent)).toEqual(["More", "New"]);
    expect(other.read()).toEqual([]);

    release();
    read.mockClear();
    expect(controls.read()).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });
});
