import { describe, expect, it } from "vitest";
import {
  analyzeSessionHtmlPreview,
  analyzeSessionHtmlPreviewCss,
  createSessionHtmlPreviewPaths,
} from "./session-html-preview.js";

const POLICY =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; font-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const meta = (policy = POLICY) => `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
const document = (body: string, policy = POLICY) =>
  `<!doctype html><html><head>${meta(policy)}</head><body>${body}</body></html>`;

describe("session HTML preview compatibility", () => {
  it("distinguishes ordinary no-policy HTML from unsupported authored policy", () => {
    expect(analyzeSessionHtmlPreview('<script src="app.js"></script>')).toEqual({
      status: "no-policy",
    });
    expect(analyzeSessionHtmlPreview(document("", "default-src 'self'"))).toMatchObject({
      status: "unsupported",
    });
  });

  it.each([
    ["unknown directive", `${POLICY}; upgrade-insecure-requests`],
    ["duplicate directive", `${POLICY}; script-src 'self'`],
    ["path source", POLICY.replace("script-src 'self'", "script-src https://preview.test/app/")],
    ["inline grant", POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")],
    ["nonce", POLICY.replace("script-src 'self'", "script-src 'self' 'nonce-test'")],
    ["override", `${POLICY}; script-src-elem 'self'`],
    ["data-only images", `${POLICY}; img-src data:`],
    ["remote media", `${POLICY}; media-src https:`],
    ["missing required declaration", POLICY.replace("font-src 'none'; ", "")],
  ])("rejects %s without rewriting the authored policy", (_name, policy) => {
    expect(
      analyzeSessionHtmlPreview(document('<script src="app.js"></script>', policy)),
    ).toMatchObject({ status: "unsupported" });
  });

  it.each([
    ["second policy", document(meta())],
    ["body policy", `<!doctype html><html><head></head><body>${meta()}</body></html>`],
    ["template policy", document(`<template>${meta()}</template>`)],
    ["noscript policy", document(`<noscript>${meta()}</noscript>`)],
    [
      "report-only policy",
      document("").replace("Content-Security-Policy", "Content-Security-Policy-Report-Only"),
    ],
    [
      "duplicate security attribute",
      document("").replace(
        '"Content-Security-Policy"',
        '"Content-Security-Policy" HTTP-EQUIV="refresh"',
      ),
    ],
    [
      "resource before policy",
      document("").replace("<head>", '<head><script src="before.js"></script>'),
    ],
    ["implicit head", meta() + '<script src="app.js"></script>'],
    ["authored base", document('<base href="./assets/">')],
    ["external module", document('<script type="module" src="app.js"></script>')],
    ["integrity", document('<script src="app.js" integrity="sha256-test"></script>')],
    ["crossorigin", document('<link rel="stylesheet" href="app.css" crossorigin>')],
  ])("rejects ambiguous or unsupported %s", (_name, source) => {
    expect(analyzeSessionHtmlPreview(source)).toMatchObject({ status: "unsupported" });
  });

  it("selects external styles and classic scripts under case-insensitive declarations", () => {
    const policy =
      POLICY.toUpperCase().replaceAll("; ", ";\t") + "; IMG-SRC 'SELF' data:; MEDIA-SRC 'NONE'";
    const source = document(
      '<link rel="stylesheet" href="./site.css"><script defer src="first.js"></script><script async src="second.js"></script><style>body { background: url(denied.png) }</style>',
      policy,
    );
    expect(analyzeSessionHtmlPreview(source)).toEqual({
      status: "supported",
      plan: {
        resources: [
          { ref: "./site.css", kind: "stylesheet" },
          { ref: "first.js", kind: "script" },
          { ref: "second.js", kind: "script" },
        ],
      },
    });
  });

  it("uses the shared srcset and media graph without admitting data or remote URLs", () => {
    expect(
      analyzeSessionHtmlPreview(
        document(
          '<img srcset="small.png 1x, data:image/png;base64,YQ== 2x, large.png 3x" src="small.png"><audio src="sound.ogg"></audio><img src="https://other.test/img.png">',
          `${POLICY}; img-src 'self' data:; media-src 'self'`,
        ),
      ),
    ).toEqual({
      status: "supported",
      plan: {
        resources: [
          { ref: "small.png", kind: "image" },
          { ref: "large.png", kind: "image" },
          { ref: "sound.ogg", kind: "media" },
        ],
      },
    });
  });

  it.each(["a/%2e%2e/app.js", "a%2fapp.js", "a\\app.js", "app%ZZ.js", "a//app.js", "a%252fapp.js"])(
    "rejects ambiguous relative URL %s",
    (ref) => {
      expect(analyzeSessionHtmlPreview(document(`<script src="${ref}"></script>`))).toMatchObject({
        status: "unsupported",
      });
    },
  );

  it("enforces one resource count across the composed HTML and stylesheet graph", () => {
    const refs = Array.from({ length: 65 }, (_, index) => `${index}.png`);
    expect(() => createSessionHtmlPreviewPaths(refs)).toThrow("resource limit");
  });
});

describe("session HTML preview CSS admission", () => {
  it.each([
    "/*",
    '@import "other.css";',
    String.raw`@\69mport "other.css";`,
    String.raw`@\000069 mport url(other.css);`,
    "@font-face { src: url(font.woff2) }",
    String.raw`@font\2d face { src: url(font.woff2) }`,
    String.raw`.hero { background: u\72l("other.png") }`,
    '.hero { background: image-set("other.png" 1x) }',
    '.hero { background: url("unterminated.png) }',
    String.raw`"broken\\
@import "other.css";`,
  ])("rejects stylesheet loading outside the one-round graph: %s", (css) => {
    expect(analyzeSessionHtmlPreviewCss(css, "styles/site.css")).toMatchObject({
      status: "unsupported",
    });
  });

  it("ignores comment and string lookalikes while decoding CSS URL tokens", () => {
    const css = String.raw`/* @import "unused.css"; url(unused.png) */ .label::after { content: "@font-face { src: url(unused) }" } .hero { background: url("../images/hero\20 image.png?v=2#crop") }`;
    expect(analyzeSessionHtmlPreviewCss(css, "styles/site.css")).toEqual({
      status: "supported",
      plan: { resources: [{ ref: "styles/../images/hero image.png?v=2#crop", kind: "image" }] },
    });
  });

  it("keeps CSS parent-relative and query identities in the same virtual resource tree", () => {
    const { paths, documentPath } = createSessionHtmlPreviewPaths([
      "styles/site.css?v=1",
      "../v0/shared.png",
      "images/icon.png?v=2#icon",
    ]);
    const prefix = "https://sandbox.test/ticket/";
    const documentUrl = new URL(documentPath, prefix);
    const stylesheet = new URL("styles/site.css?v=1", documentUrl);
    expect(stylesheet.href).toBe(new URL(paths.get("styles/site.css?v=1")!.path, prefix).href);
    expect(stylesheet.search).toBe("?v=1");
    expect(new URL("../../v0/shared.png", stylesheet).href).toBe(
      new URL(paths.get("../v0/shared.png")!.path, prefix).href,
    );
    const icon = paths.get("images/icon.png?v=2#icon")!;
    expect(icon.fragment).toBe("#icon");
    expect(new URL("../images/icon.png?v=2#icon", stylesheet).href).toBe(
      new URL(icon.path + icon.fragment, prefix).href,
    );
  });

  it("retains browser path punctuation and percent aliases used by untouched CSS", () => {
    const result = analyzeSessionHtmlPreviewCss(
      '.hero { background: url("../images/a+b%21.png?v=2") }',
      "styles/site.css",
    );
    expect(result).toEqual({
      status: "supported",
      plan: { resources: [{ ref: "styles/../images/a+b%21.png?v=2", kind: "image" }] },
    });
    expect(
      createSessionHtmlPreviewPaths(["images/a+b%21.png?v=2"]).paths.get("images/a+b%21.png?v=2"),
    ).toEqual({ path: "images/a+b%21.png?v=2", fragment: "" });
  });

  it("keeps the shell document separate from every resource filename and query", () => {
    const { paths, documentPath } = createSessionHtmlPreviewPaths([
      "preview.html",
      "preview1.html?v=2",
      "../preview2.html",
      "%70review3.html",
    ]);
    for (const { path } of paths.values()) {
      expect(path.split("?", 1)[0]).not.toBe(documentPath);
    }
  });
});

it("selects the browser's active noscript resources in strict mode", () => {
  const source = document(
    '<noscript><img src="fallback.png"></noscript>',
    `${POLICY}; img-src 'self'`,
  );
  expect(analyzeSessionHtmlPreview(source, false)).toMatchObject({
    status: "supported",
    plan: { resources: [{ ref: "fallback.png", kind: "image" }] },
  });
  expect(analyzeSessionHtmlPreview(source, true)).toMatchObject({
    status: "supported",
    plan: { resources: [] },
  });
});
