import { afterEach, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import "../styles/base.css";
import "../styles/chat/text.css";
import "../styles/sidebar-markdown.css";
import "../pages/chat/components/chat-attribution.css";

const title = "A resolved session title long enough to need truncation in a narrow chat bubble";
function createHost(className: string) {
  const host = document.createElement("div");
  Object.assign(host, { id: "session-link-proof", className });
  document.body.append(host);
  return host;
}
function setTheme(theme: string) {
  Object.assign(document.documentElement.dataset, { theme, themeMode: theme });
}

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

it.each([
  ["chat-text", "inline-grid"],
  ["sidebar-markdown", "inline-grid"],
  ["chat-reply-attribution", "grid"],
  ["chat-reply-attribution chat-reply-attribution--forwarded", "grid"],
])("styles links and preserves keyboard focus in %s", async (className, display) => {
  const host = createHost(className);
  host.innerHTML =
    '<a class="markdown-session-link" href="/chat/main/raw">agent:main:raw</a>' +
    '<a class="markdown-session-link markdown-session-link--titled" href="/chat/main/resolved"><span class="session-label">Resolved title</span></a>' +
    '<a class="markdown-session-link" href="/chat/main/code"><code>agent:main:code</code></a>' +
    '<a class="markdown-session-link markdown-session-link--titled markdown-session-link--automation" href="/chat/main/cron"><span class="session-label">Automation</span></a>' +
    '<a class="markdown-session-link markdown-session-link--titled markdown-session-link--agent" href="/chat/research"><span class="session-label">Research</span></a>';
  const start = document.createElement("button");
  start.textContent = "Start keyboard navigation";
  host.prepend(start);
  for (const theme of ["light", "dark"]) {
    setTheme(theme);
    const titled = host.querySelector(".markdown-session-link--titled")!;
    expect(getComputedStyle(titled)).toMatchObject({
      color: getComputedStyle(host.querySelector("a")!).color,
      display,
    });
    expect(getComputedStyle(titled.firstElementChild!).textOverflow).toBe("ellipsis");
    await userEvent.click(start);
    for (const link of host.querySelectorAll("a")) {
      const style = getComputedStyle(link);
      for (const side of ["Top", "Right", "Bottom", "Left"] as const) {
        expect(style[`border${side}Width`]).toBe("0px");
      }
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement).toBe(link);
      expect(link.matches(":focus-visible")).toBe(true);
      expect(getComputedStyle(link)).toMatchObject({ outlineStyle: "solid", outlineWidth: "2px" });
    }
  }
});

it.each(["light", "dark"] as const)("aligns and truncates resolved titles in %s", (theme) => {
  setTheme(theme);
  const host = createHost("chat-text");
  host.innerHTML = `<p>Open <a class="markdown-session-link markdown-session-link--titled" href="/chat/main/research"><span class="session-label">${title}</span></a> or <a class="markdown-session-link" href="/chat/main/unknown">an untitled session</a>.</p>`;
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
  const color = getComputedStyle(link).color;
  expect(color).toBe(getComputedStyle(untitled).color);
  expect(getComputedStyle(link, "::before")).toMatchObject({
    backgroundColor: color,
    maskImage: expect.stringContaining("data:image/svg+xml"),
    animationName: "none",
  });
  outer.remove();
  inner.remove();
  expect(link.textContent).toBe(title);
});
