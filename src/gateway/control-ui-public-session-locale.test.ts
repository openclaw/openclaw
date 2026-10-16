import { runInNewContext } from "node:vm";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
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
      toolOther: "Outils exécutés : {count}",
    },
    ar: { top: "أعلى", refreshNow: "تحديث" },
    de: { top: "</script><img src=x onerror=alert(1)>" },
  },
}));
const readers: JSDOM[] = [];
afterEach(() => {
  readers.splice(0).forEach((dom) => dom.window.close());
  vi.useRealTimers();
});
const messages = [
  { role: "user", content: "Keep this original request" },
  {
    role: "assistant",
    content: "Original answer\n\n\u0060\u0060\u0060js\nconst value = 1;\n\u0060\u0060\u0060",
  },
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
  const dom = new JSDOM(render(), { url: "https://reader.test/chat/main/topic" });
  readers.push(dom);
  const { document, localStorage } = dom.window;
  Object.defineProperty(document, "hidden", { value: false });
  if (preference !== undefined) {
    localStorage.setItem("openclaw.i18n.locale", preference);
  }
  const storage = blockedStorage
    ? {
        getItem() {
          throw new Error("Blocked");
        },
      }
    : localStorage;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(async () => new Response(render(), { status: 200 }));
  runInNewContext(document.querySelector("script")!.textContent!, {
    document,
    window: dom.window,
    location: dom.window.location,
    navigator: { language },
    localStorage: storage,
    fetch,
    AbortSignal,
    setTimeout,
    clearTimeout,
    DOMParser: dom.window.DOMParser,
  });
  return { document, fetch, localStorage };
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
      const f = open(language!, preference, blocked!);
      expect(f.document.documentElement.lang).toBe(locale);
      expect(f.document.documentElement.dir).toBe(direction);
      expect(f.document.querySelector("[data-public-top]")?.textContent).toContain(top);
      expect(f.document.title).toBe("Original title · OpenClaw");
      expect(f.document.querySelector(".content")?.textContent).toBe(
        "Keep this original request\n",
      );
      expect(f.document.querySelector("code")?.textContent).toBe("const value = 1;\n");
      expect(f.document.querySelector(".content")?.getAttribute("dir")).toBe("auto");
      expect(f.localStorage.getItem("openclaw.i18n.locale")).toBe(preference ?? null);
    },
  );
  it("retains localized chrome and copy controls across refresh and revocation", async () => {
    const f = open("fr-FR");
    expect(f.document.querySelector(".copy")?.getAttribute("aria-label")).toBe("Copier le code");
    f.document.querySelector<HTMLAnchorElement>("[data-public-refresh-now]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.document.querySelector(".copy")?.getAttribute("title")).toBe("Copier");
    expect(f.document.querySelector("[data-public-refresh-status]")?.textContent).toBe("À jour");
    expect(f.document.querySelector("footer a")?.textContent).toBe("Actualiser");
    f.fetch.mockImplementation(async () => new Response(render(true), { status: 404 }));
    f.document.querySelector<HTMLAnchorElement>("[data-public-refresh-now]")!.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.document.title).toBe("Conversation indisponible · OpenClaw");
    expect(f.document.querySelector(".transcript")).toBeNull();
  });
  it("keeps catalog strings inert inside the CSP-bound inline script and DOM", () => {
    const f = open("de-DE");
    expect(f.document.querySelectorAll("script")).toHaveLength(1);
    expect(f.document.querySelector("[data-public-top]")?.textContent).toContain(
      "</script><img src=x onerror=alert(1)>",
    );
    expect(f.document.querySelector("img[src=x]")).toBeNull();
  });
});
