import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { renderPublicSessionDocument } from "./control-ui-public-session-render.js";

// Synthetic catalog fixture isolates reader behavior from generated translation freshness.
vi.mock("./control-ui-public-session-locales.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./control-ui-public-session-locales.js")>()),
  PUBLIC_SESSION_LOCALES: {
    fr: {
      top: "Haut",
      refreshNow: "Actualiser",
      copy: "Copier",
      copyToClipboard: "Copier le code",
      upToDate: "À jour",
      unavailableTitle: "Conversation indisponible",
    },
    ar: { top: "أعلى" },
    de: { top: "</script><img src=x onerror=alert(1)>" },
  },
}));
afterEach(() => vi.useRealTimers());
const messages = [
  { role: "user", content: "Question" },
  { role: "assistant", content: "Answer\n\n```js\n1;\n```" },
];
function render(unavailable = false) {
  return renderPublicSessionDocument({
    title: unavailable ? "Conversation unavailable" : "Original title",
    messages,
    unavailable,
    truncated: false,
    latestUrl: "/chat/main/topic",
    cardUrl: "https://reader.test/card.png",
    assetBasePath: "",
  });
}
function open(language: string, preference?: string, blockedStorage = false) {
  vi.useFakeTimers();
  const dom = new JSDOM(render(), {
    url: "https://reader.test/chat/main/topic",
    runScripts: "outside-only",
  });
  onTestFinished(() => dom.window.close());
  const { document, localStorage } = dom.window;
  Object.defineProperty(document, "hidden", { value: false });
  if (preference !== undefined) {
    localStorage.setItem("openclaw.i18n.locale", preference);
  }
  Object.defineProperty(dom.window.navigator, "language", { value: language });
  if (blockedStorage) {
    Object.defineProperty(dom.window, "localStorage", {
      get() {
        throw new Error("Blocked");
      },
    });
  }
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(render(), { status: 200 }));
  Object.assign(dom.window, { fetch, AbortSignal, setTimeout, clearTimeout });
  runInContext(document.querySelector("script")!.textContent!, dom.getInternalVMContext());
  const find = (selector: string) => document.querySelector<HTMLElement>(selector);
  return { document, fetch, localStorage, find };
}

describe("public reader language", () => {
  it.each([
    ["fr-CA", undefined, false, "fr", "ltr", "Haut"],
    ["fr-FR", "en", false, "en", "ltr", "Top"],
    ["en-US", "ar", false, "ar", "rtl", "أعلى"],
    ["ar-EG", "unsupported", false, "ar", "rtl", "أعلى"],
    ["fr-FR", undefined, true, "fr", "ltr", "Haut"],
    ["zz-ZZ", undefined, false, "en", "ltr", "Top"],
    ["zh-Hans-TW", undefined, false, "zh-CN", "ltr", "Top"],
    ["zh-Hant-CN", undefined, false, "zh-TW", "ltr", "Top"],
    ["pt-PT", undefined, false, "pt-BR", "ltr", "Top"],
  ])(
    "selects %s with preference %s (blocked storage: %s)",
    (language, preference, blocked, locale, direction, top) => {
      const { document, find, localStorage } = open(language!, preference, blocked!);
      expect(document.documentElement).toMatchObject({ lang: locale, dir: direction });
      expect(find("[data-public-top]")?.textContent).toContain(top);
      expect(document.title).toBe("Original title · OpenClaw");
      expect(find(".content")?.textContent).toBe("Question\n");
      expect(find(".content")?.getAttribute("dir")).toBe("auto");
      expect(find("code")?.textContent).toBe("1;\n");
      expect(localStorage.getItem("openclaw.i18n.locale")).toBe(preference ?? null);
    },
  );
  it("retains localized chrome and copy controls across refresh and revocation", async () => {
    const { document, fetch, find } = open("fr-FR");
    expect(find(".copy")?.getAttribute("aria-label")).toBe("Copier le code");
    find("[data-public-refresh-now]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(find(".copy")?.getAttribute("title")).toBe("Copier");
    expect(find("[data-public-refresh-status]")?.textContent).toBe("À jour");
    expect(find("footer a")?.textContent).toBe("Actualiser");
    fetch.mockImplementation(async () => new Response(render(true), { status: 404 }));
    find("[data-public-refresh-now]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(document.title).toBe("Conversation indisponible · OpenClaw");
    expect(find(".transcript")).toBeNull();
  });
  it("keeps catalog strings inert inside the CSP-bound inline script and DOM", () => {
    const { document, find } = open("de-DE");
    expect(document.querySelectorAll("script")).toHaveLength(1);
    expect(find("[data-public-top]")?.textContent).toContain(
      "</script><img src=x onerror=alert(1)>",
    );
    expect(find("img[src=x]")).toBeNull();
  });
});
