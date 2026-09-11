import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import { renderForwardedAttribution } from "../pages/chat/components/chat-forwarded-attribution.ts";
import "../styles/base.css";
import "../styles/chat/text.css";
import "../styles/chat/grouped.css";

const title = "A resolved session title long enough to wrap in a narrow chat bubble";

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
      link.before(outer);
      label.prepend(inner);

      for (const width of [240, 700]) {
        host.style.width = `${width}px`;
        expect(
          Math.abs(inner.getBoundingClientRect().bottom - outer.getBoundingClientRect().bottom),
        ).toBeLessThan(0.6);
        expect(host.scrollWidth).toBeLessThanOrEqual(width);
        if (width === 240) {
          expect(label.getClientRects().length).toBeGreaterThan(1);
        }
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

  it.each(["sidebar-markdown", "chat-reply-attribution"])(
    "shares the titled-link treatment in %s",
    (className) => {
      const host = document.createElement("div");
      host.id = "session-link-proof";
      host.className = className;
      host.style.width = "240px";
      host.innerHTML = `<span>From</span><a class="markdown-session-link markdown-session-link--titled"><span class="session-label">${title}</span></a><a class="markdown-session-link">untitled</a>`;
      document.body.append(host);
      const [titled, untitled] = host.querySelectorAll("a");
      expect(getComputedStyle(titled!).color).toBe(getComputedStyle(untitled!).color);
      expect(titled!.firstElementChild!.getClientRects().length).toBeGreaterThan(1);
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
      expect(titled!.textContent).toBe(title);
      const outer = baselineMarker();
      const inner = baselineMarker();
      host.firstElementChild!.prepend(outer);
      titled!.firstElementChild!.prepend(inner);
      expect(
        Math.abs(inner.getBoundingClientRect().bottom - outer.getBoundingClientRect().bottom),
      ).toBeLessThan(0.6);
    },
  );

  it.each(["agent:research:notes", "LegacySessionWithoutAnyWordBreaks"])(
    "contains forwarded attribution with a long unbroken name: %s",
    (sessionKey) => {
      const host = document.createElement("div");
      host.id = "session-link-proof";
      host.style.width = "240px";
      document.body.append(host);
      render(
        renderForwardedAttribution(
          {
            kind: "group",
            key: "forwarded",
            role: "assistant",
            senderSession: { sessionKey },
            messages: [],
            visibleContent: "text",
            timestamp: 0,
            isStreaming: false,
          },
          {
            agentId: "main",
            agents: [{ id: "research", identity: { name: "UnbrokenResearchAgentDisplayName" } }],
          },
        ),
        host,
      );
      expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
    },
  );
});
