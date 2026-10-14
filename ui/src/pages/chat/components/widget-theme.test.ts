/* @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { postWidgetTheme, registerWidgetThemeFrame } from "../../../lib/widget-theme.ts";

function stubComputedStyles(values: Record<string, string>) {
  vi.stubGlobal(
    "getComputedStyle",
    vi.fn(
      () =>
        ({
          getPropertyValue: (name: string) => values[name] ?? "",
        }) as CSSStyleDeclaration,
    ),
  );
}

function postedMessage(postMessage: ReturnType<typeof vi.fn>) {
  return postMessage.mock.calls[0] as [unknown, string];
}

beforeEach(() => {
  // Other UI files can leave observers attached to the shared jsdom root.
  document.documentElement.replaceWith(document.documentElement.cloneNode(true));
});

afterEach(() => {
  document.body.replaceChildren();
  document.head.querySelectorAll("[data-widget-theme-test]").forEach((node) => node.remove());
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.themeMode;
});

describe("widget theme bridge", () => {
  function mountedWidget() {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    const post = vi.spyOn(frame.contentWindow!, "postMessage");
    registerWidgetThemeFrame(frame, "https://widget.example");
    postWidgetTheme(frame);
    return post;
  }

  it("refreshes a mounted widget when custom palette CSS is inserted, edited, or removed", async () => {
    const values = { "--bg": "#ffffff" };
    stubComputedStyles(values);
    const post = mountedWidget();
    const style = document.createElement("style");
    style.dataset.widgetThemeTest = "";
    values["--bg"] = "#112233";
    style.textContent = ":root { --bg: #112233; }";
    document.head.append(style);
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokens: { surface: "#112233" } }),
      "https://widget.example",
    );
    for (const replaceTextNode of [false, true]) {
      values["--bg"] = replaceTextNode ? "#556677" : "#334455";
      const css = `:root { --bg: ${values["--bg"]}; }`;
      if (replaceTextNode) {
        style.textContent = css;
      } else {
        style.firstChild!.textContent = css;
      }
      await Promise.resolve();
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({ tokens: { surface: values["--bg"] } }),
        "https://widget.example",
      );
    }
    values["--bg"] = "#ffffff";
    style.remove();
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokens: { surface: "#ffffff" } }),
      "https://widget.example",
    );
  });

  it("refreshes loaded or replaced stylesheets without a root attribute change", async () => {
    const values = { "--bg": "#ffffff" };
    stubComputedStyles(values);
    const post = mountedWidget();
    const link = document.createElement("link");
    link.dataset.widgetThemeTest = "";
    link.rel = "stylesheet";
    link.href = "/themes/tide.css";
    document.head.append(link);
    await Promise.resolve();
    for (const color of ["#112233", "#334455"]) {
      link.href = `/themes/${color.slice(1)}.css`;
      await Promise.resolve();
      values["--bg"] = color;
      // Resource load events do not bubble.
      link.dispatchEvent(new Event("load"));
      expect(post).toHaveBeenLastCalledWith(
        expect.objectContaining({ tokens: { surface: color } }),
        "https://widget.example",
      );
    }
  });

  it("refreshes plugin CSS when its downloaded stylesheet is activated", async () => {
    const values = { "--bg": "#ffffff" };
    stubComputedStyles(values);
    const post = mountedWidget();
    const link = document.createElement("link");
    link.dataset.widgetThemeTest = "";
    link.rel = "stylesheet";
    link.media = "not all";
    document.head.append(link);
    await Promise.resolve();
    values["--bg"] = "#112233";
    link.media = "all";
    await Promise.resolve();
    expect(post).toHaveBeenLastCalledWith(
      expect.objectContaining({ tokens: { surface: "#112233" } }),
      "https://widget.example",
    );
  });

  it("posts host variables mapped to widget tokens, dropping empty values", () => {
    document.documentElement.dataset.themeMode = "light";
    stubComputedStyles({
      "--bg": "  #faf9f7  ",
      "--card": "#ffffff",
      "--text": "   ",
      "--accent": "#bd4531",
      "--primary": "#bd4531",
      "--primary-foreground": "#fff",
      "--radius-full": "9999px",
      "--scrollbar-size": "12px",
      "--scrollbar-thumb-inset": "3px",
      "--scrollbar-thumb": "rgba(110, 105, 96, 0.32)",
      "--scrollbar-thumb-hover": "rgba(110, 105, 96, 0.64)",
      "--mono": " ui-monospace ",
    });
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;

    postWidgetTheme(frame);

    const [message, origin] = postedMessage(postMessage);
    expect(origin).toBe("*");
    expect(message).toEqual({
      type: "openclaw:widget-theme",
      mode: "light",
      tokens: {
        surface: "#faf9f7",
        card: "#ffffff",
        accent: "#bd4531",
        "accent-fill": "#bd4531",
        "accent-fg": "#fff",
        "radius-full": "9999px",
        "scrollbar-size": "12px",
        "scrollbar-thumb-inset": "3px",
        "scrollbar-thumb": "rgba(110, 105, 96, 0.32)",
        "scrollbar-thumb-hover": "rgba(110, 105, 96, 0.64)",
        "font-mono": "ui-monospace",
      },
    });
  });

  it("targets the exact origin for authenticated cross-origin embeds", () => {
    document.documentElement.dataset.themeMode = "dark";
    stubComputedStyles({ "--bg": "#0e1015", "--accent": "#ff5c5c" });
    const postMessage = vi.fn();
    const frame = { contentWindow: { postMessage } } as unknown as HTMLIFrameElement;

    postWidgetTheme(frame, "https://discussion.example");

    expect(postedMessage(postMessage)).toEqual([
      {
        type: "openclaw:widget-theme",
        mode: "dark",
        tokens: { surface: "#0e1015", accent: "#ff5c5c" },
      },
      "https://discussion.example",
    ]);
  });

  it("shares one token sample across frames and refreshes mounted widgets on root changes", async () => {
    const values = { "--bg": "#ffffff", "--accent": "#c41e30" };
    stubComputedStyles(values);
    const readStyles = vi.mocked(getComputedStyle);
    const chatFrame = document.createElement("iframe");
    chatFrame.className = "chat-tool-card__preview-frame";
    const boardFrame = document.createElement("iframe");
    boardFrame.className = "board-widget__frame";
    const host = document.createElement("div");
    const shadowFrame = document.createElement("iframe");
    host.attachShadow({ mode: "open" }).append(shadowFrame);
    const unrelatedFrame = document.createElement("iframe");
    document.body.append(chatFrame, boardFrame, host, unrelatedFrame);
    const chatPost = vi.spyOn(chatFrame.contentWindow!, "postMessage");
    const boardPost = vi.spyOn(boardFrame.contentWindow!, "postMessage");
    const shadowPost = vi.spyOn(shadowFrame.contentWindow!, "postMessage");
    const unrelatedPost = vi.spyOn(unrelatedFrame.contentWindow!, "postMessage");
    const release = registerWidgetThemeFrame(shadowFrame, "https://widget.example");

    for (const frame of [chatFrame, boardFrame, shadowFrame]) {
      postWidgetTheme(frame);
    }
    expect(readStyles).toHaveBeenCalledTimes(1);
    expect(chatPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tokens: { surface: "#ffffff", accent: "#c41e30" },
      }),
      "*",
    );

    values["--bg"] = "#101010";
    document.documentElement.dataset.themeMode = "dark";
    // A newly loaded frame must see the new palette before observer delivery.
    postWidgetTheme(chatFrame);
    expect(chatPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "dark",
        tokens: { surface: "#101010", accent: "#c41e30" },
      }),
      "*",
    );
    await Promise.resolve();
    expect(boardPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "dark",
        tokens: { surface: "#101010", accent: "#c41e30" },
      }),
      "*",
    );
    expect(shadowPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        mode: "dark",
        tokens: { surface: "#101010", accent: "#c41e30" },
      }),
      "https://widget.example",
    );

    readStyles.mockClear();
    values["--accent"] = "#207d82";
    document.documentElement.style.setProperty("--accent", "#207d82");
    await Promise.resolve();
    expect(readStyles).toHaveBeenCalledTimes(1);
    expect(boardPost).toHaveBeenLastCalledWith(
      expect.objectContaining({
        tokens: { surface: "#101010", accent: "#207d82" },
      }),
      "*",
    );
    expect(unrelatedPost).not.toHaveBeenCalled();
    release();
  });
});
