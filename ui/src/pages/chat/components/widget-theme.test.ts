/* @vitest-environment jsdom */

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { postWidgetTheme, registerWidgetThemeFrame } from "../../../lib/widget-theme.ts";

function stubComputedStyles(values: Record<string, string>) {
  const styles = {
    getPropertyValue: (name: string) => values[name] ?? "",
  } as CSSStyleDeclaration;
  vi.stubGlobal(
    "getComputedStyle",
    vi.fn(() => styles),
  );
}

function expectTheme(post: ReturnType<typeof vi.fn>, theme: object, origin = "*") {
  expect(post).toHaveBeenLastCalledWith(expect.objectContaining(theme), origin);
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

function appendStylesheet(properties: Partial<HTMLLinkElement>) {
  const link = Object.assign(document.createElement("link"), { rel: "stylesheet" }, properties);
  link.dataset.widgetThemeTest = "";
  document.head.append(link);
  return link;
}

function makeFrame(className = "", parent: Node = document.body) {
  const frame = document.createElement("iframe");
  frame.className = className;
  parent.appendChild(frame);
  const post = vi.spyOn(frame.contentWindow!, "postMessage");
  return { frame, post };
}

function mountedWidget() {
  const values = { "--bg": "#ffffff" };
  stubComputedStyles(values);
  const { frame, post } = makeFrame();
  registerWidgetThemeFrame(frame, "https://widget.example");
  postWidgetTheme(frame);
  return { values, post };
}

it("refreshes a mounted widget when custom palette CSS is inserted, edited, or removed", async () => {
  const { values, post } = mountedWidget();
  const style = document.createElement("style");
  style.dataset.widgetThemeTest = "";
  values["--bg"] = "#112233";
  style.textContent = ":root { --bg: #112233; }";
  document.head.append(style);
  await Promise.resolve();
  expectTheme(post, { tokens: { surface: "#112233" } }, "https://widget.example");
  for (const replaceTextNode of [false, true]) {
    values["--bg"] = replaceTextNode ? "#556677" : "#334455";
    const css = `:root { --bg: ${values["--bg"]}; }`;
    if (replaceTextNode) {
      style.textContent = css;
    } else {
      style.firstChild!.textContent = css;
    }
    await Promise.resolve();
    expectTheme(post, { tokens: { surface: values["--bg"] } }, "https://widget.example");
  }
  values["--bg"] = "#ffffff";
  style.remove();
  await Promise.resolve();
  expectTheme(post, { tokens: { surface: "#ffffff" } }, "https://widget.example");
});

it("refreshes loaded or replaced stylesheets without a root attribute change", async () => {
  const { values, post } = mountedWidget();
  const link = appendStylesheet({ href: "/themes/tide.css" });
  await Promise.resolve();
  for (const color of ["#112233", "#334455"]) {
    link.href = `/themes/${color.slice(1)}.css`;
    await Promise.resolve();
    values["--bg"] = color;
    // Resource load events do not bubble.
    link.dispatchEvent(new Event("load"));
    expectTheme(post, { tokens: { surface: color } }, "https://widget.example");
  }
});

it("refreshes plugin CSS when its downloaded stylesheet is activated", async () => {
  const { values, post } = mountedWidget();
  const link = appendStylesheet({ media: "not all" });
  await Promise.resolve();
  values["--bg"] = "#112233";
  link.media = "all";
  await Promise.resolve();
  expectTheme(post, { tokens: { surface: "#112233" } }, "https://widget.example");
});

it("posts host variables mapped to widget tokens, dropping empty values", () => {
  document.documentElement.dataset.themeMode = "light";
  const mappings = [
    ["--bg", "surface", "#faf9f7"],
    ["--card", "card", "#ffffff"],
    ["--accent", "accent", "#bd4531"],
    ["--primary", "accent-fill", "#bd4531"],
    ["--primary-foreground", "accent-fg", "#fff"],
    ["--radius-full", "radius-full", "9999px"],
    ["--scrollbar-size", "scrollbar-size", "12px"],
    ["--scrollbar-thumb-inset", "scrollbar-thumb-inset", "3px"],
    ["--scrollbar-thumb", "scrollbar-thumb", "rgba(110, 105, 96, 0.32)"],
    ["--scrollbar-thumb-hover", "scrollbar-thumb-hover", "rgba(110, 105, 96, 0.64)"],
    ["--mono", "font-mono", "ui-monospace"],
  ];
  stubComputedStyles({
    ...Object.fromEntries(mappings.map(([source, , value]) => [source, `  ${value}  `])),
    "--text": "   ",
  });
  const { frame, post } = makeFrame();
  postWidgetTheme(frame);
  expect(post.mock.calls[0]).toEqual([
    {
      type: "openclaw:widget-theme",
      mode: "light",
      tokens: Object.fromEntries(mappings.map(([, token, value]) => [token, value])),
    },
    "*",
  ]);
});

it("targets the exact origin for authenticated cross-origin embeds", () => {
  document.documentElement.dataset.themeMode = "dark";
  stubComputedStyles({ "--bg": "#0e1015", "--accent": "#ff5c5c" });
  const { frame, post } = makeFrame();
  postWidgetTheme(frame, "https://discussion.example");
  expect(post.mock.calls[0]).toEqual([
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
  const { frame: chatFrame, post: chatPost } = makeFrame("chat-tool-card__preview-frame");
  const { frame: boardFrame, post: boardPost } = makeFrame("board-widget__frame");
  const host = document.createElement("div");
  document.body.append(host);
  const { frame: shadowFrame, post: shadowPost } = makeFrame(
    "",
    host.attachShadow({ mode: "open" }),
  );
  const { post: unrelatedPost } = makeFrame("board-widget__frame");
  const releases = [
    registerWidgetThemeFrame(chatFrame, "*"),
    registerWidgetThemeFrame(boardFrame, "*"),
    registerWidgetThemeFrame(shadowFrame, "https://widget.example"),
  ];

  for (const frame of [chatFrame, boardFrame, shadowFrame]) {
    postWidgetTheme(frame);
  }
  expect(readStyles).toHaveBeenCalledTimes(1);
  expectTheme(chatPost, { tokens: { surface: "#ffffff", accent: "#c41e30" } });

  values["--bg"] = "#101010";
  document.documentElement.dataset.themeMode = "dark";
  // A newly loaded frame must see the new palette before observer delivery.
  postWidgetTheme(chatFrame);
  const darkTheme = { mode: "dark", tokens: { surface: "#101010", accent: "#c41e30" } };
  expectTheme(chatPost, darkTheme);
  await Promise.resolve();
  expectTheme(boardPost, darkTheme);
  expectTheme(shadowPost, darkTheme, "https://widget.example");

  readStyles.mockClear();
  values["--accent"] = "#207d82";
  document.documentElement.style.setProperty("--accent", "#207d82");
  await Promise.resolve();
  expect(readStyles).toHaveBeenCalledTimes(1);
  expectTheme(boardPost, { tokens: { surface: "#101010", accent: "#207d82" } });
  expect(unrelatedPost).not.toHaveBeenCalled();

  boardFrame.remove();
  document.documentElement.dataset.themeMode = "light";
  await Promise.resolve();
  document.body.append(boardFrame);
  const reattachedPost = vi.spyOn(boardFrame.contentWindow!, "postMessage");
  document.documentElement.dataset.themeMode = "dark";
  await Promise.resolve();
  expect(reattachedPost).toHaveBeenCalledWith(
    expect.objectContaining({ type: "openclaw:widget-theme", mode: "dark" }),
    "*",
  );
  releases.forEach((release) => release());
});
