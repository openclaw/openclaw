import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTestLinkReader } from "../test-helpers/link-reader.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

const title = "Edit configuration as text";
const href = "https://github.com/openclaw/openclaw/pull/99816";
const providerTag = "openclaw-link-reader-hovercard-provider";
function fixture(content = "", hint = title, preview = false) {
  const container = document.createElement(preview ? providerTag : "div");
  container.innerHTML = preview
    ? `<a href="${href}" title="${hint}">${content}</a>`
    : `<button title="${hint}">${content}</button>`;
  if (preview) {
    installTestLinkReader(container);
  }
  document.body.append(container);
  return { container, button: container.querySelector<HTMLElement>("button, a")! };
}
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

// Accessible names and opacity require real layout.
const suite = describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function");
suite("title tooltip accessible names", () => {
  let page: (typeof import("vitest/browser"))["page"];
  let dispose: () => void;
  const named = (name: string) => page.getByRole("button", { name, exact: true });
  const release = async (node: HTMLElement, hint: string) => {
    await page.elementLocator(node).unhover();
    node.blur();
    expect(node).toMatchObject({ title: hint, ariaLabel: null });
  };

  beforeEach(async () => {
    ({ page } = await import("vitest/browser"));
    dispose = installTitleTooltips(document);
  });

  afterEach(() => {
    dispose();
    document.body.replaceChildren();
  });

  it.each([
    ["pointer", "button"],
    ["pointer", "ancestor"],
    ["focus", "button"],
    ["focus", "ancestor"],
  ] as const)("keeps the text name after %s during %s fade-in", async (input, target) => {
    const { button, container } = fixture("Edit");
    const animated = target === "button" ? button : container;
    animated.style.opacity = "0";
    const namedButton = named("Edit");
    expect(namedButton.elements()).toEqual([button]);
    expect(button.checkVisibility({ checkOpacity: true })).toBe(false);

    if (input === "pointer") {
      await page.elementLocator(button).hover();
    } else {
      button.focus();
    }
    expect(button.title).toBe("");
    animated.style.opacity = "1";
    await nextFrame();
    expect(button.checkVisibility({ checkOpacity: true })).toBe(true);
    expect(namedButton.elements()).toEqual([button]);
    await namedButton.click();
  });

  it.each([
    ["container", false],
    ["button", false],
    ["label", true],
  ] as const)("judges repeated titles with %s faded", async (fadedPart, expectedOpen) => {
    const { button, container } = fixture("<span>Active</span>", "Active");
    const parts = { container, button, label: button.querySelector("span")! };
    parts[fadedPart].style.opacity = "0";

    parts.button.focus();
    await nextFrame();
    const open = document.querySelector("openclaw-tooltip")?.hasAttribute("open") ?? false;
    expect(open).toBe(expectedOpen);
  });

  it("releases an injected name when an existing text node becomes the label", async () => {
    const label = document.createTextNode("");
    const { button } = fixture();
    button.append(label);
    await page.elementLocator(button).hover();
    expect(named(title).elements()).toEqual([button]);

    label.data = "Edit";
    await expect.poll(() => named("Edit").elements()).toEqual([button]);
  });

  it.each(["label", "nested subtree"] as const)("tracks %s aria-hidden", async (target) => {
    const { button } = fixture("<span><span>Edit</span></span>");
    const hidden = button.querySelector(target === "label" ? "span span" : "span")!;
    hidden.setAttribute("aria-hidden", "true");
    const titleNamedButton = named(title);
    await titleNamedButton.hover();
    expect(button.title).toBe("");
    expect(titleNamedButton.elements()).toEqual([button]);

    for (const isHidden of [false, true]) {
      const name = isHidden ? title : "Edit";
      hidden.setAttribute("aria-hidden", String(isHidden));
      await expect.poll(() => named(name).elements()).toEqual([button]);
      await named(name).click();
    }

    await release(button, title);
    expect(titleNamedButton.elements()).toEqual([button]);
  });

  it.each([
    ["hidden", ""],
    ["style", "display:none"],
    ["style", "visibility:hidden"],
    ["aria-hidden", "true"],
    ["preview", ""],
  ])("keeps the title name for text with %s=%s", async (attribute, value) => {
    const preview = attribute === "preview";
    const { button: trigger, container } = fixture(
      preview
        ? '<svg aria-hidden="true" width="20" height="20"></svg>'
        : "<span>Decorative text</span>",
      title,
      preview,
    );
    if (!preview) {
      trigger.querySelector("span")!.setAttribute(attribute, value);
    }
    const locator = page.getByRole(preview ? "link" : "button", { name: title, exact: true });
    expect(locator.elements()).toEqual([trigger]);
    await locator.hover();
    expect(trigger).toMatchObject({ title: "", ariaLabel: title });
    expect(trigger.hasAttribute("aria-expanded")).toBe(false);
    expect(locator.elements()).toEqual([trigger]);
    await release(trigger, title);
    expect(locator.elements()).toEqual([trigger]);
    if (preview) {
      expect(container.querySelector("a")?.href).toBe(href);
    }
  });

  it("preserves an explicit name supplied while the tooltip owns a temporary name", async () => {
    const { button } = fixture();
    await page.elementLocator(button).hover();
    button.setAttribute("aria-label", "Open editor");
    button.title = "Updated hint";
    await expect.poll(() => button.title).toBe("");
    await page.elementLocator(button).unhover();
    expect(named("Open editor").elements()).toEqual([button]);
    expect(button.title).toBe("Updated hint");
  });
});
