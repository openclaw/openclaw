// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importCustomThemeFromUrl } from "../pages/config/custom-theme-import.ts";
import {
  createImportedCustomThemeFixture as createImportedTheme,
  createTweakcnThemePayload as createTweakcnPayload,
} from "../test-helpers/custom-theme.ts";
import { parseImportedCustomTheme, syncCustomThemeStyleTag } from "./custom-theme.ts";
import type { ImportedCustomTheme } from "./custom-theme.ts";

beforeEach(() => vi.stubGlobal("fetch", vi.fn()));

afterEach(() => vi.unstubAllGlobals());

function createResponse(
  body = JSON.stringify(createTweakcnPayload()),
  options: {
    body?: ReadableStream<Uint8Array> | null;
    headers?: HeadersInit;
    status?: number;
    url?: string;
  } = {},
) {
  const response = new Response(options.body === undefined ? body : options.body, options);
  Object.defineProperty(response, "url", { value: options.url ?? "" });
  vi.spyOn(response, "text").mockResolvedValue(body);
  return response;
}

const themeId = "cmlhfpjhw000004l4f4ax3m7z";
const sourceUrl = `https://tweakcn.com/themes/${themeId}`;
const fetchUrl = `https://tweakcn.com/r/themes/${themeId}`;
const firstFetchCall = () => vi.mocked(fetch).mock.calls[0]!;
function importTheme(response = createResponse(), input = sourceUrl) {
  vi.mocked(fetch).mockResolvedValue(response);
  return importCustomThemeFromUrl(input);
}

describe("custom theme import helpers", () => {
  it("keeps imported theme labels on a UTF-16 boundary", () => {
    const parsed = parseImportedCustomTheme({
      ...createImportedTheme(),
      label: `${"a".repeat(79)}🚀tail`,
    });

    expect(parsed?.label).toBe("a".repeat(79));
  });

  it("fetches tweakcn themes with bounded no-redirect requests", async () => {
    expect(await importTheme()).toMatchObject({
      label: "Light Green",
      sourceUrl,
      light: { bg: "oklch(0.98 0.01 120)", "font-body": "Inter, system-ui, sans-serif" },
      dark: {
        bg: "oklch(0.12 0.04 265)",
        "accent-hover": "color-mix(in srgb, var(--accent) 82%, white 18%)",
      },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(firstFetchCall()).toEqual([
      fetchUrl,
      {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      },
    ]);
  });

  it.each([
    "https://tweakcn.com/editor/theme?theme=cmlhfpjhw000004l4f4ax3m7z",
    "https://tweakcn.com/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    "/r/themes/cmlhfpjhw000004l4f4ax3m7z",
    "cmlhfpjhw000004l4f4ax3m7z",
    "Theme link: https://tweakcn.com/themes/cmlhfpjhw000004l4f4ax3m7z.",
  ])("imports supported tweakcn input form %s", async (input) => {
    expect(await importTheme(createResponse(), input)).toMatchObject({ themeId, sourceUrl });
    expect(firstFetchCall()[0]).toBe(fetchUrl);
  });

  it.each([
    [{ headers: { "content-length": "200001" } }, "too large"],
    [{ body: null }, "unreadable theme payload"],
    [{ url: "https://example.com/r/themes/foreign-theme" }, "Unexpected redirect"],
  ] as const)("rejects unreadable or untrusted responses (%j)", async (options, error) => {
    const response = createResponse(undefined, options);
    await expect(importTheme(response)).rejects.toThrow(error);
    expect(response.text).not.toHaveBeenCalled();
  });

  it("rejects unsafe tweakcn content-length values before acquiring the body reader", async () => {
    const response = createResponse("{}", {
      headers: { "content-length": "9007199254740993" },
    });
    const cancel = vi.spyOn(response.body!, "cancel");
    const getReader = vi.spyOn(response.body!, "getReader").mockImplementation(() => {
      throw new Error("reader should not be acquired");
    });
    await expect(importTheme(response)).rejects.toThrow("too large");
    expect(getReader).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['url("https://example.com/track")', "background"],
    ["oklch(0.98 0.01 120)/*", "background"],
    ['image-set("https://example.com/pixel.png" 1x)', "background"],
    ["var(--attacker-font)", "font-sans"],
  ])("rejects unsafe imported CSS token %s", async (token, key) => {
    const payload = createTweakcnPayload();
    if (key === "font-sans") {
      payload.cssVars.theme[key] = token;
    } else {
      payload.cssVars.light.background = token;
    }
    await expect(importTheme(createResponse(JSON.stringify(payload)))).rejects.toThrow(
      "Unsupported tweakcn token",
    );
  });

  it("validates imported font families without regex backtracking", async () => {
    const payload = createTweakcnPayload();
    payload.cssVars.theme["font-sans"] = `${"Inter, ".repeat(20)}@bad`;
    await expect(importTheme(createResponse(JSON.stringify(payload)))).rejects.toThrow(
      "Unsupported tweakcn token",
    );
  });

  it("parses stored imported themes and rejects malformed records", () => {
    const imported = createImportedTheme();

    expect(parseImportedCustomTheme(imported)?.themeId).toBe(themeId);
    expect(parseImportedCustomTheme({ ...imported, themeId: "claude" })?.themeId).toBe("claude");
    expect(parseImportedCustomTheme({ ...imported, light: {} })).toBeNull();
  });

  it("syncs the managed custom theme style tag in the document head", () => {
    const appendChild = vi.fn();
    const remove = vi.fn();
    const style = { id: "", textContent: "", remove } as unknown as HTMLStyleElement;
    const createElement = vi.fn(() => style);
    const getElementById = vi.fn<() => HTMLStyleElement | null>(() => null);
    vi.stubGlobal("document", {
      head: { appendChild },
      createElement,
      getElementById,
    });

    syncCustomThemeStyleTag(createImportedTheme());

    expect(appendChild).toHaveBeenCalledWith(style);
    expect(style.id).toBe("openclaw-custom-theme");
    expect(style.textContent).toContain(':root[data-theme="custom"]');

    getElementById.mockReturnValue(style);
    syncCustomThemeStyleTag(null);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("removes the managed style tag when a stored theme is missing tokens", () => {
    const remove = vi.fn();
    vi.stubGlobal("document", {
      getElementById: vi.fn(() => ({ remove })),
    } as unknown as Document);
    const theme = { ...createImportedTheme(), light: undefined } as unknown as ImportedCustomTheme;

    syncCustomThemeStyleTag(theme);

    expect(remove).toHaveBeenCalledOnce();
  });
});
