/* @vitest-environment jsdom */
import type { JSX } from "@solidjs/web";
import { createSignal, flush, For } from "solid-js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import {
  controlsForHovercard,
  createHovercardControlRef,
  HovercardControlsContext,
} from "./portaled-hovercard-focus.ts";
import { SessionHovercard } from "./session-hovercard-solid.tsx";
import { ProgressCardMarkdown } from "./session-progress-card-view.tsx";
import { CopyButton } from "./solid/copy-button.tsx";
import { settleTooltip } from "./tooltip.test-support.ts";

let container: HTMLDivElement;
let controls: ReturnType<typeof controlsForHovercard>;
beforeEach(() => {
  container = document.body.appendChild(document.createElement("div"));
  controls = controlsForHovercard(container);
});
afterEach(() => container.remove());
const labels = () => controls.read().map((element) => element.textContent);
function mount(content: () => JSX.Element) {
  return mountSolid(
    () => <HovercardControlsContext value={controls}>{content()}</HovercardControlsContext>,
    { container },
  );
}

it("follows committed row order and excludes controls outside the active tab sequence", () => {
  const [items, setItems] = createSignal(["first", "second"]);
  const view = mount(() => (
    <>
      <For each={items()}>
        {(item) => <button ref={createHovercardControlRef()}>{item}</button>}
      </For>
      <button>Unregistered</button>
      <button ref={createHovercardControlRef()} disabled />
      <a ref={createHovercardControlRef()} href="#decorative" tabindex="-1" />
    </>
  ));

  expect(labels()).toEqual(["first", "second"]);
  const first = view.getByRole("button", { name: "first" });
  const second = view.getByRole("button", { name: "second" });
  // A native control can also appear in an island source; keep one tab stop.
  onTestFinished(controls.registerSource(() => [first]));
  setItems(["second", "first"]);
  flush();
  expect(controls.read().slice(0, 2)).toEqual([second, first]);

  first.setAttribute("disabled", "");
  expect(labels()).toEqual(["second"]);
});

it("registers session participant inspection and native facepile links through their owning bridge", async () => {
  const [participants, setParticipants] = createSignal(
    ["Alice", "Mira", "Riley"].map((label) => ({
      identity: { type: "profile" as const, id: label.toLowerCase() },
      label,
    })),
  );
  const view = mount(() => (
    <SessionHovercard
      row={{
        label: "Review session",
        hasActiveRun: false,
        hasAutomation: false,
        participants: participants(),
      }}
      personActivity={{ basePath: "", navigate: vi.fn() }}
    />
  ));

  const tooltip = container.querySelector<HTMLElementTagNameMap["openclaw-tooltip"]>(
    "openclaw-tooltip.session-hovercard__participants-tooltip",
  )!;
  await settleTooltip(tooltip);
  const name = container.querySelector(".session-hovercard__attribution-name")!;
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
  for (const open of [true, false]) {
    trigger.click();
    await settleTooltip(tooltip);
    expect(tooltip.hasAttribute("open")).toBe(open);
    const details = open ? [miraDetail, rileyDetail] : [];
    expect(controls.read()).toEqual([name, trigger, ...details, miraAvatar, rileyAvatar]);
  }
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

it.each(["copy", "markdown"] as const)("retires replaced %s controls and their owner", (kind) => {
  const other = controlsForHovercard(document.createElement("div"));
  const [value, setValue] = createSignal("Old");
  const view = mount(() => (
    <>
      <button>Outside island</button>
      {kind === "copy" ? (
        <CopyButton ref={createHovercardControlRef()} text={value()} idleLabel="Copy value" />
      ) : (
        <ProgressCardMarkdown
          markdown={value() ? `[${value()}](#link)` : ""}
          registerControls={controls.registerSource}
        />
      )}
    </>
  ));
  const findControl = (label: string) =>
    view.getByRole(kind === "copy" ? "button" : "link", {
      name: kind === "copy" ? "Copy value" : label,
    });
  const original = findControl("Old");
  expect(controlsForHovercard(container)).toBe(controls);
  expect(controls.read()).toEqual([original]);
  setValue("New");
  flush();
  const replacement = findControl("New");
  if (kind === "copy") {
    expect(replacement).not.toBe(original);
    // Reattach retired nodes so disconnected-node filtering cannot hide leaked registrations.
    container.append(original);
  }
  expect(controls.read()).toEqual([replacement]);
  expect(other.read()).toEqual([]);
  if (kind === "markdown") {
    setValue("");
    flush();
    container.append(replacement);
    expect(controls.read()).toEqual([]);
    setValue("Current");
    flush();
    expect(controls.read()).toEqual([findControl("Current")]);
  }
  const last = kind === "copy" ? replacement : findControl("Current");
  view.unmount();
  container.append(last);
  expect(controls.read()).toEqual([]);
});
