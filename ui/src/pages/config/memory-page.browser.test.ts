import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { nextFrame } from "../../test-helpers/modal-dialog.ts";
import "../../styles/base.css";
import "../../styles/layout.css";
import "../../styles/settings.css";
import "../../styles/hub-tabs.css";
import "../../styles/config.css";

const hasBrowserLayout = !navigator.userAgent.toLowerCase().includes("jsdom");
const layoutTolerancePx = 1;
let host: HTMLDivElement | undefined;

afterEach(() => {
  host?.remove();
  host = undefined;
});

function mountMemory(settings = false) {
  host = document.createElement("div");
  host.className = "shell shell--settings";
  host.innerHTML = `
    <main class="content content--memory-page ${settings ? "content--settings-page" : ""}"
      style="box-sizing: border-box; width: 1152px; ${settings ? "" : "height: 600px; overflow-y: auto"}">
      <section class="memory-page">
        <section class="content-header content-header--page hub-page-header"
          ${settings ? 'style="width: 100%; max-width: 1120px; margin-inline: auto"' : ""}>
          <div class="hub-page-header__title">Memory</div>
          <div class="hub-page-header__tabs">Overview Memories Dreams Settings</div>
          <div class="hub-page-header__actions">Agent</div>
        </section>
        <div class="memory-page__panel" ${settings ? "" : 'style="height: 200px"'}>
          ${settings ? '<div class="settings-page"></div>' : ""}
        </div>
      </section>
    </main>`;
  document.body.append(host);
  return (selector: string) => expectDefined(host?.querySelector<HTMLElement>(selector), selector);
}

const expectFixed = (before: number, after: number) =>
  expect(Math.abs(after - before)).toBeLessThanOrEqual(layoutTolerancePx);

describe.skipIf(!hasBrowserLayout)("Memory page browser layout", () => {
  it("keeps header children fixed when Dreams drops the settings-page marker", async () => {
    const find = mountMemory(true);
    const header = find(".hub-page-header");
    const title = find(".hub-page-header__title");
    const actions = find(".hub-page-header__actions");
    const measure = () => ({
      paddingInlineStart: getComputedStyle(header).paddingInlineStart,
      title: title.getBoundingClientRect(),
      actions: actions.getBoundingClientRect(),
    });
    const before = measure();

    find(".settings-page").remove();
    find(".content").classList.remove("content--settings-page");
    await nextFrame();

    const after = measure();
    expect(after.paddingInlineStart).toBe(before.paddingInlineStart);
    expectFixed(before.title.left, after.title.left);
    expectFixed(before.actions.right, after.actions.right);
  });

  it("keeps horizontal hero geometry fixed when a subview changes scrollbar state", async () => {
    const find = mountMemory();
    const content = find(".content");
    const header = find(".hub-page-header");
    const tabs = find(".hub-page-header__tabs");
    const measure = () => ({
      clientWidth: content.clientWidth,
      header: header.getBoundingClientRect(),
      tabs: tabs.getBoundingClientRect(),
    });
    const before = measure();

    find(".memory-page__panel").style.height = "1200px";
    await nextFrame();

    const after = measure();
    expect(getComputedStyle(content).scrollbarGutter).toBe("stable");
    expect(after.clientWidth).toBe(before.clientWidth);
    expectFixed(before.header.left, after.header.left);
    expectFixed(before.header.right, after.header.right);
    expectFixed(before.tabs.left, after.tabs.left);
  });
});
