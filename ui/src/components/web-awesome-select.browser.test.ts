import { afterEach, describe, expect, it } from "vitest";
import { duringElementAnimation } from "../test-helpers/web-awesome-animation.ts";
import "@awesome.me/webawesome/dist/styles/themes/default.css";
import "./web-awesome-select.ts";

type Select = HTMLElementTagNameMap["wa-select"];

function rendered(select: Select) {
  return select.updateComplete;
}

async function optionsRendered(select: Select) {
  await rendered(select);
  await Promise.all(
    [...select.querySelectorAll("wa-option")].map((option) => option.updateComplete),
  );
}

function open(select: Select) {
  return select.show();
}

function onShown(select: Select, listener: () => void) {
  select.addEventListener("wa-after-show", listener);
}

async function interruptClosing(
  select: Select,
  close: () => Promise<void>,
  reopen: () => Promise<void>,
) {
  await duringElementAnimation(select.popup.popup, "hide", close, async () => {
    await reopen();
    await rendered(select);
  });
  await expect.poll(() => select.popup.popup.getAnimations().length).toBe(0);
  await rendered(select);
  await select.popup.updateComplete;
}

afterEach(() => document.body.replaceChildren());

describe.runIf("__vitest_browser__" in globalThis)("Web Awesome select lifecycle", () => {
  it("keeps a reopened option visible and selectable after an interrupted hide", async () => {
    const { page, userEvent } = await import("vitest/browser");
    const host = document.createElement("div");
    host.style.cssText = "width: 20rem; padding: 2rem";
    host.innerHTML = `<wa-select label="Model" value="default">
      <wa-option value="default">Default</wa-option>
      <wa-option value="selected">Reopened option</wa-option>
    </wa-select>`;
    const select = host.querySelector("wa-select")!;
    document.body.append(host);
    await optionsRendered(select);
    const events: string[] = [];
    const changes: unknown[] = [];
    onShown(select, () => events.push("shown"));
    select.addEventListener("change", () => changes.push(select.value));

    await page.getByRole("combobox", { name: "Model", exact: true }).click();
    await expect.element(page.getByRole("option", { name: "Default", exact: true })).toBeVisible();
    await expect.poll(() => events).toEqual(["shown"]);
    await interruptClosing(
      select,
      () => userEvent.keyboard("{Escape}"),
      () => page.getByRole("combobox", { name: "Model", exact: true }).click(),
    );

    const option = select.querySelector<HTMLElement>('wa-option[value="selected"]')!;
    await expect.element(option).toBeVisible();
    await page.elementLocator(option).click();
    await expect.poll(() => changes).toEqual(["selected"]);
    await expect.element(option).not.toBeVisible();
  });

  it("shows a selectable option when called immediately after connection", async () => {
    const { page } = await import("vitest/browser");
    const select = document.createElement("wa-select");
    select.label = "Model";
    select.innerHTML = '<wa-option value="chosen">Available option</wa-option>';
    document.body.append(select);

    await open(select);
    const option = select.querySelector("wa-option")!;
    await expect.element(option).toBeVisible();
    await page.elementLocator(option).click();
    expect(select.value).toBe("chosen");
    await expect.element(option).not.toBeVisible();
  });
});
