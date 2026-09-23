import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../styles/base.css";
import "../styles/chat/text.css";
import "../styles/sidebar-markdown.css";
import "../styles/chat/grouped.css";

const title = "A resolved session title long enough to need truncation in a narrow chat bubble";

// Zero-sized inline boxes expose the line's baseline without relying on font metrics.
function baselineMarker(): HTMLSpanElement {
  const marker = document.createElement("span");
  marker.style.cssText =
    "display:inline-block;width:0;height:0;padding:0;margin:0;border:0;vertical-align:baseline";
  return marker;
}

afterEach(() => {
  document.querySelector("#session-link-proof")?.remove();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
});

describe("session link presentation", () => {
  it.each([
    "chat-text",
    "sidebar-markdown",
    "chat-reply-attribution",
    "chat-reply-attribution chat-reply-attribution--forwarded",
  ])(
    "keeps session references borderless without removing keyboard focus in %s",
    async (className) => {
      const host = document.createElement("div");
      host.id = "session-link-proof";
      host.className = className;
      host.innerHTML =
        '<a class="markdown-session-link" href="/chat/main/raw">agent:main:raw</a>' +
        '<a class="markdown-session-link markdown-session-link--titled" href="/chat/main/resolved"><span class="session-label">Resolved title</span></a>' +
        '<a class="markdown-session-link" href="/chat/main/code"><code>agent:main:code</code></a>' +
        '<a class="markdown-session-link markdown-session-link--titled markdown-session-link--automation" href="/chat/main/cron"><span class="session-label">Automation</span></a>' +
        '<a class="markdown-session-link markdown-session-link--titled markdown-session-link--agent" href="/chat/research"><span class="session-label">Research</span></a>';
      const start = document.createElement("button");
      start.textContent = "Start keyboard navigation";
      host.prepend(start);
      document.body.append(host);
      for (const theme of ["light", "dark"]) {
        document.documentElement.dataset.theme = theme;
        document.documentElement.dataset.themeMode = theme;
        await userEvent.click(start);
        for (const link of host.querySelectorAll("a")) {
          const style = getComputedStyle(link);
          expect([
            style.borderTopWidth,
            style.borderRightWidth,
            style.borderBottomWidth,
            style.borderLeftWidth,
          ]).toEqual(["0px", "0px", "0px", "0px"]);
          await userEvent.keyboard("{Tab}");
          expect(document.activeElement).toBe(link);
          expect(link.matches(":focus-visible")).toBe(true);
          expect(getComputedStyle(link).outlineStyle).toBe("solid");
          expect(getComputedStyle(link).outlineWidth).toBe("2px");
        }
      }
    },
  );

  it.each(["light", "dark"] as const)(
    "keeps resolved titles on the text baseline with shared link color in %s",
    (theme) => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.dataset.themeMode = theme;
      const host = document.createElement("div");
      host.id = "session-link-proof";
      host.className = "chat-text";
      host.innerHTML = `<p>Open <a class="markdown-session-link markdown-session-link--titled" href="/chat/main/research"><span class="session-label">${title}</span></a> or <a class="markdown-session-link" href="/chat/main/unknown">an untitled session</a>.</p>`;
      document.body.append(host);
      const link = host.querySelector<HTMLAnchorElement>("a")!;
      const label = link.querySelector<HTMLSpanElement>("span")!;
      const untitled = host.querySelectorAll("a")[1]!;
      const outer = baselineMarker();
      const inner = baselineMarker();
      link.after(outer);
      label.prepend(inner);

      for (const width of [240, 700]) {
        host.style.width = `${width}px`;
        expect(
          Math.abs(inner.getBoundingClientRect().bottom - outer.getBoundingClientRect().bottom),
        ).toBeLessThan(0.6);
        expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
        expect(getComputedStyle(label).textOverflow).toBe("ellipsis");
        expect(link.getBoundingClientRect().width).toBeLessThanOrEqual(width);
      }
      expect(getComputedStyle(link).color).toBe(getComputedStyle(untitled).color);
      expect(getComputedStyle(link, "::before").backgroundColor).toBe(getComputedStyle(link).color);
      expect(getComputedStyle(link, "::before").maskImage).toContain("data:image/svg+xml");
      expect(getComputedStyle(link, "::before").animationName).toBe("none");
      outer.remove();
      inner.remove();
      expect(link.textContent).toBe(title);
    },
  );

  // Flex items blockify inline-grid; ordinary Markdown links retain their inline outer display.
  it.each([
    ["sidebar-markdown", "inline-grid"],
    ["chat-reply-attribution", "grid"],
  ])("shares the titled-link treatment in %s", (className, expectedDisplay) => {
    const host = document.createElement("div");
    host.id = "session-link-proof";
    host.className = className;
    host.innerHTML = `<a class="markdown-session-link markdown-session-link--titled"><span class="session-label">${title}</span></a><a class="markdown-session-link">untitled</a>`;
    document.body.append(host);
    const [titled, untitled] = host.querySelectorAll("a");
    expect(getComputedStyle(titled!).color).toBe(getComputedStyle(untitled!).color);
    expect(getComputedStyle(titled!).display).toBe(expectedDisplay);
    expect(getComputedStyle(titled!.firstElementChild!).textOverflow).toBe("ellipsis");
  });
});
