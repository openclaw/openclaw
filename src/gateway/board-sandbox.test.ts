import { expect, it, vi } from "vitest";
import {
  buildSandboxHostDocument as buildHost,
  decodeSandboxHostCsp,
  normalizeSandboxHostCsp,
} from "../agents/sandbox-host.js";
import { buildWidgetDocument } from "../canvas/wrap.js";
import { WIDGET_CDN_ORIGINS } from "../plugin-sdk/widget-html.js";
import {
  buildBoardWidgetContentSecurityPolicy as widgetPolicy,
  buildBoardWidgetSandboxPath,
} from "./board-sandbox.js";

function document(grantState: "pending" | "granted", netOrigins = ["https://api.open-meteo.com"]) {
  return { grantState, declared: { netOrigins } };
}

function sandbox(widget: Parameters<typeof buildBoardWidgetSandboxPath>[0]) {
  const url = new URL(buildBoardWidgetSandboxPath(widget), "https://sandbox.example");
  const csp = decodeSandboxHostCsp(url.searchParams.get("csp"));
  return { csp, policies: [hostPolicy(csp), widgetPolicy(widget)] };
}

const hostPolicy = (csp?: Parameters<typeof buildHost>[0]) =>
  buildHost(csp).headers["Content-Security-Policy"];
const directives = (policy: string | undefined) =>
  policy?.split(";").map((entry) => entry.trim().split(/\s+/u));

it("reuses the fixed sandbox policy without reparsing origins and observes grant changes", () => {
  const widget = document("pending");
  const fixed = buildBoardWidgetSandboxPath(widget);
  const parse = vi.spyOn(URL, "parse");
  try {
    expect(buildBoardWidgetSandboxPath(widget)).toBe(fixed);
    expect(buildBoardWidgetSandboxPath({ grantState: "none" })).toBe(fixed);
    expect(parse).not.toHaveBeenCalled();
    widget.grantState = "granted";
    expect(sandbox(widget).csp?.connectDomains).toEqual(widget.declared.netOrigins);
    widget.grantState = "pending";
    expect(buildBoardWidgetSandboxPath(widget)).toBe(fixed);
  } finally {
    parse.mockRestore();
  }
});

it("permits HTTPS and generated media without granting other network access", () => {
  const { policies } = sandbox(document("pending"));
  const html = buildWidgetDocument("Video", '<video src="https://media.test/v.mp4"></video>');
  const meta = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  for (const policy of [meta, ...policies]) {
    const parsed = directives(policy);
    const find = (name: string) => parsed?.find(([directive]) => directive === name);
    const media = find("media-src");
    expect(media).toEqual(expect.arrayContaining(["https:", "blob:", "data:"]));
    expect(media).not.toContain("http:");
    expect(find("connect-src")).toEqual(["connect-src", "'none'"]);
    for (const name of ["script-src", "style-src", "font-src", "img-src"]) {
      expect(find(name)).not.toContain("https:");
    }
  }
  expect(directives(hostPolicy())?.find(([name]) => name === "media-src")).not.toContain("https:");
});

it("normalizes media-only sources without widening resource or connection sources", () => {
  const mediaDomains = ["https:", "blob:", "https://media.example"];
  const csp = normalizeSandboxHostCsp({
    mediaDomains: [...mediaDomains, "javascript:", "https:; connect-src *"],
    resourceDomains: ["https:", "blob:"],
    connectDomains: ["https:"],
  });
  expect(csp).toEqual({ mediaDomains });
});

it("grants API access only to the declared widget origins", () => {
  const origins = ["https://api.test", "https://s.test:8443", "https://[2001:db8::1]:9443"];
  const { csp, policies } = sandbox(document("granted", origins));

  expect(csp).toEqual({
    connectDomains: origins,
    blockDescendantFrames: true,
    resourceDomains: [...WIDGET_CDN_ORIGINS],
    mediaDomains: ["https:", "blob:"],
  });
  for (const policy of policies) {
    expect(policy).toContain(`connect-src ${origins.join(" ")}`);
  }
});

it("preserves registered resource origins alongside the widget CDNs without granting fetch", () => {
  const widget = {
    ...document("pending"),
    resourceOrigins: ["https://plugin-assets.example", "https://cdn.jsdelivr.net"],
  };
  const { csp, policies } = sandbox(widget);

  expect(csp?.resourceDomains).toEqual([...WIDGET_CDN_ORIGINS, "https://plugin-assets.example"]);
  expect(csp?.connectDomains).toBeUndefined();
  for (const policy of policies) {
    expect(policy).toContain("https://plugin-assets.example");
    expect(policy).toContain("connect-src 'none'");
  }
});

it("adds the requested descendant-frame guard before resetting document port offers", () => {
  const proxy = buildHost({ blockDescendantFrames: true }).html;
  const genericProxy = buildHost().html;

  for (const snippet of [
    "const blockDescendantFrames = true",
    "sandbox descendant browsing contexts are disabled",
    'lock(Document.prototype,\\"createElement\\"',
    'wrapSetter(Element.prototype,\\"innerHTML\\"',
    'wrapMethod(Element.prototype,\\"setHTMLUnsafe\\"',
    "const apply=Reflect.apply",
    'if (html.slice(index, index + 4) !== "<!--") break',
    'const commentEnd = html.indexOf("-->", index + 4)',
  ]) {
    expect(proxy).toContain(snippet);
  }
  const guardedHtmlIndex = proxy.indexOf("const guardedHtml = guardDocument(params.html)");
  expect(guardedHtmlIndex).toBeGreaterThan(-1);
  const clearIndex = proxy.indexOf("widgetPortsOffered.clear()", guardedHtmlIndex);
  expect(clearIndex).toBeGreaterThan(guardedHtmlIndex);
  expect(genericProxy).toContain("const blockDescendantFrames = false");
  expect(genericProxy).not.toContain('lock(Document.prototype,\\"createElement\\"');
});
