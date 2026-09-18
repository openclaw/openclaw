/* @vitest-environment jsdom */
import { html, render } from "lit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startNativeLinkRouting } from "../app/native-link-routing.ts";
import { i18n } from "../i18n/index.ts";
import { refreshExternalLinkPresentation } from "../lib/external-link-presentation.ts";
import { renderExternalLinkLabel } from "./external-link.ts";

beforeEach(async () => {
  await i18n.setLocale("en");
});
afterEach(() => {
  document.body.replaceChildren();
});

describe("explicit product navigation labels", () => {
  it("follows native panel routing and restores the announcement when its owner disposes", () => {
    let panel = false;
    const routing = startNativeLinkRouting({ shouldOpenInControlUiBrowser: () => panel });
    const container = document.createElement("div");
    document.body.append(container);
    try {
      render(
        html`<a href="https://example.test/guide"
          >${renderExternalLinkLabel("Docs", "https://example.test/guide")}</a
        >`,
        container,
      );
      const assertPresentation = (opensInPanel: boolean) => {
        expect(
          container.querySelectorAll('[role="img"][aria-label="opens in a new tab"]'),
        ).toHaveLength(opensInPanel ? 0 : 1);
        expect(container.querySelectorAll("svg")).toHaveLength(opensInPanel ? 0 : 1);
        expect(container.textContent?.trim()).toBe("Docs");
      };
      assertPresentation(false);
      for (const next of [true, false, true]) {
        panel = next;
        refreshExternalLinkPresentation();
        assertPresentation(next);
      }
      routing.dispose();
      assertPresentation(false);
    } finally {
      routing.dispose();
      render(null, container);
    }
  });

  it.each([
    ["https://docs.example.test/guide", true],
    ["http://docs.example.test/guide", true],
    ["//docs.example.test/guide", true],
    [`${location.origin}/settings/about`, false],
    ["/settings/about", false],
    ["#details", false],
    ["/chat/main/research", false],
    ["mailto:help@example.test", false],
  ])("keeps explicitly marked navigation accurate for %s", (href, external) => {
    const container = document.createElement("div");
    render(html`<a href=${href}>${renderExternalLinkLabel("Docs", href)}</a>`, container);
    expect(
      container.querySelectorAll('[role="img"][aria-label="opens in a new tab"]'),
    ).toHaveLength(external ? 1 : 0);
    expect(container.textContent?.trim()).toBe("Docs");
    render(null, container);
  });
});
