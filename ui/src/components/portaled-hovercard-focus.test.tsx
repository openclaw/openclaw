/* @vitest-environment jsdom */
import { createSignal, flush, For } from "solid-js";
import { describe, expect, it, onTestFinished, vi } from "vitest";
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
    // A native control can also appear in an island source; keep one tab stop.
    onTestFinished(controls.registerSource(() => [first]));
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
    const [participants, setParticipants] = createSignal([
      { identity: { type: "profile" as const, id: "alice" }, label: "Alice" },
      { identity: { type: "profile" as const, id: "mira" }, label: "Mira" },
      { identity: { type: "profile" as const, id: "riley" }, label: "Riley" },
    ]);
    const view = mountSolid(
      () => (
        <HovercardControlsContext value={controls}>
          <SessionHovercard
            row={{
              label: "Review session",
              hasActiveRun: false,
              hasAutomation: false,
              participants: participants(),
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

    setParticipants((current) => current.filter((person) => person.identity.id !== "mira"));
    await settleTooltip(tooltip);
    expect(miraAvatar.isConnected).toBe(false);
    container.append(miraAvatar);
    expect(controls.read()).not.toContain(miraAvatar);
    expect(controls.read()).toContain(rileyAvatar);

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
          <CopyButton ref={createHovercardControlRef()} text={text()} idleLabel="Copy value" />
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

  it("reads current session Markdown and retires removed islands independently per card", () => {
    const container = card();
    const controls = controlsForHovercard(container);
    const other = controlsForHovercard(card());
    const [markdown, setMarkdown] = createSignal("[Old](#old)");
    const view = mountSolid(
      () => (
        <HovercardControlsContext value={controls}>
          <button>Outside island</button>
          <SessionHovercard
            progressCard={{
              sessionKey: "agent:main:hovercard-test",
              revision: 1,
              updatedAt: 1,
              markdown: markdown(),
            }}
          />
        </HovercardControlsContext>
      ),
      { container },
    );
    onTestFinished(view.unmount);
    expect(controlsForHovercard(container)).toBe(controls);
    expect(controls.read().map((element) => element.textContent)).toEqual(["Old"]);

    setMarkdown("[New](#new)");
    flush();
    expect(controls.read().map((element) => element.textContent)).toEqual(["New"]);
    expect(other.read()).toEqual([]);
    const retired = controls.read()[0]!;
    setMarkdown("");
    flush();
    container.append(retired);
    expect(controls.read()).toEqual([]);

    setMarkdown("[Current](#current)");
    flush();
    const current = view.getByRole("link", { name: "Current" });
    expect(controls.read()).toEqual([current]);
    view.unmount();
    container.append(current);
    expect(controls.read()).toEqual([]);
  });
});
