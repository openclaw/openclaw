import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installTestLinkReader } from "../test-helpers/link-reader.ts";
import { installTitleTooltips } from "./tooltip-title.ts";

const title = "Edit configuration as text";
function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]>,
  ...children: (Node | string)[]
) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
const nextFrame = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });

// Accessible names and opacity require real layout; keep the canonical browser-only gate.
describe.skipIf(typeof HTMLElement.prototype.checkVisibility !== "function")(
  "title tooltip accessible names",
  () => {
    let page: (typeof import("vitest/browser"))["page"];
    let dispose: () => void;
    const named = (name: string) => page.getByRole("button", { name, exact: true });

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
    ] as const)(
      "preserves a text-labelled button after %s enhancement during a %s opacity transition",
      async (input, target) => {
        const button = element("button", { title }, "Edit");
        const container = element("div", {}, button);
        const animated = target === "button" ? button : container;
        animated.style.opacity = "0";
        document.body.append(container);
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
      },
    );

    it.each([
      ["an entering ancestor", "container", false],
      ["the trigger itself", "button", false],
      ["the label inside the trigger", "label", true],
    ] as const)(
      "judges a repeated title against text faded by %s",
      async (_case, fadedPart, expectedOpen) => {
        const label = element("span", {}, "Active");
        const button = element("button", { title: "Active" }, label);
        const container = element("div", {}, button);
        const parts = { container, button, label };
        document.body.append(container);
        parts[fadedPart].style.opacity = "0";

        parts.button.focus();
        await nextFrame();
        expect(document.querySelector("openclaw-tooltip")?.hasAttribute("open") ?? false).toBe(
          expectedOpen,
        );
      },
    );

    it("releases an injected name when an existing text node becomes the label", async () => {
      const label = document.createTextNode("");
      const button = element("button", { title }, label);
      document.body.append(button);
      await page.elementLocator(button).hover();
      expect(named(title).elements()).toEqual([button]);

      label.data = "Edit";
      await expect.poll(() => named("Edit").elements()).toEqual([button]);
    });

    it.each(["label", "nested subtree"] as const)(
      "updates the active name when aria-hidden changes on the %s",
      async (target) => {
        const label = element("span", {}, "Edit");
        const wrapper = element("span", {}, label);
        const button = element("button", { title }, wrapper);
        const hidden = target === "label" ? label : wrapper;
        hidden.setAttribute("aria-hidden", "true");
        document.body.append(button);
        const titleNamedButton = named(title);
        const textNamedButton = named("Edit");
        await titleNamedButton.hover();
        expect(button.title).toBe("");
        expect(titleNamedButton.elements()).toEqual([button]);

        hidden.setAttribute("aria-hidden", "false");
        await expect.poll(() => textNamedButton.elements()).toEqual([button]);
        await textNamedButton.click();

        hidden.setAttribute("aria-hidden", "true");
        await expect.poll(() => titleNamedButton.elements()).toEqual([button]);
        await titleNamedButton.click();

        await page.elementLocator(button).unhover();
        button.blur();
        expect(button.title).toBe(title);
        expect(button.hasAttribute("aria-label")).toBe(false);
        expect(titleNamedButton.elements()).toEqual([button]);
      },
    );

    it.each(["hidden", "display", "visibility", "aria-hidden"] as const)(
      "preserves title naming when the only text is %s",
      async (hidden) => {
        const label = element("span", {}, "Decorative text");
        const button = element("button", { title: "Edit configuration" }, label);
        if (hidden === "hidden") {
          label.hidden = true;
        }
        if (hidden === "display") {
          label.style.display = "none";
        }
        if (hidden === "visibility") {
          label.style.visibility = "hidden";
        }
        if (hidden === "aria-hidden") {
          label.setAttribute("aria-hidden", "true");
        }
        document.body.append(button);
        const namedButton = named("Edit configuration");
        expect(namedButton.elements()).toEqual([button]);
        await page.elementLocator(button).hover();
        expect(namedButton.elements()).toEqual([button]);
        await page.elementLocator(button).unhover();
        expect(button.title).toBe("Edit configuration");
        expect(button.hasAttribute("aria-label")).toBe(false);
        expect(namedButton.elements()).toEqual([button]);
      },
    );

    it("preserves an icon-only GitHub link name while its title hint is reserved for a preview", async () => {
      const provider = installTestLinkReader(
        document.createElement("openclaw-link-reader-hovercard-provider"),
      );
      const href = "https://github.com/openclaw/openclaw/pull/99816";
      const link = element("a", {
        href,
        title: "Issue details",
        innerHTML: '<svg aria-hidden="true" width="20" height="20"></svg>',
      });
      provider.append(link);
      document.body.append(provider);
      const namedLink = page.getByRole("link", { name: "Issue details", exact: true });
      expect(namedLink.elements()).toEqual([link]);
      await namedLink.hover();
      expect(link.title).toBe("");
      expect(link.getAttribute("aria-label")).toBe("Issue details");
      expect(link.hasAttribute("aria-expanded")).toBe(false);
      expect(namedLink.elements()).toEqual([link]);
      await page.elementLocator(link).unhover();
      link.blur();
      expect(link.title).toBe("Issue details");
      expect(link.hasAttribute("aria-label")).toBe(false);
      expect(namedLink.elements()).toEqual([link]);
      expect(link.href).toBe(href);
    });

    it("preserves an explicit name supplied while the tooltip owns a temporary name", async () => {
      const button = element("button", { title });
      document.body.append(button);
      await page.elementLocator(button).hover();
      button.setAttribute("aria-label", "Open editor");
      button.title = "Updated hint";
      await expect.poll(() => button.title).toBe("");
      await page.elementLocator(button).unhover();
      expect(named("Open editor").elements()).toEqual([button]);
      expect(button.title).toBe("Updated hint");
    });
  },
);
