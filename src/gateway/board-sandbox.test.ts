import { describe, expect, it } from "vitest";
import { buildSandboxHostDocument, decodeSandboxHostCsp } from "../agents/sandbox-host.js";
import type { BoardWidgetDocument } from "../boards/board-store.js";
import { WIDGET_CDN_ORIGINS } from "../plugin-sdk/widget-html.js";
import {
  buildBoardWidgetContentSecurityPolicy,
  buildBoardWidgetSandboxPath,
} from "./board-sandbox.js";

function document(
  grantState: "pending" | "granted",
  netOrigins = ["https://api.open-meteo.com"],
): BoardWidgetDocument {
  return {
    html: "<!doctype html>",
    revision: 1,
    sha256: "a".repeat(64),
    viewGeneration: "b".repeat(32),
    grantState,
    declared: { netOrigins },
  };
}

describe("board widget sandbox CSP", () => {
  it("allows static CDN resources without granting API access while a declaration is pending", () => {
    const path = buildBoardWidgetSandboxPath(document("pending"));
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");

    const csp = decodeSandboxHostCsp(encoded);
    expect(csp).toEqual({
      blockDescendantFrames: true,
      resourceDomains: [...WIDGET_CDN_ORIGINS],
    });
    for (const policy of [
      buildSandboxHostDocument(csp).headers["Content-Security-Policy"],
      buildBoardWidgetContentSecurityPolicy(document("pending")),
    ]) {
      expect(policy).toContain("connect-src 'none'");
      expect(policy).toContain("webrtc 'block'");
      for (const directive of ["script-src", "style-src", "font-src"]) {
        const sources = policy.split("; ").find((entry) => entry.startsWith(`${directive} `));
        for (const origin of WIDGET_CDN_ORIGINS) {
          expect(sources).toContain(origin);
        }
        expect(sources?.split(/\s+/u)).not.toContain("https:");
      }
    }
  });

  it("grants API access only to the declared widget origins", () => {
    const path = buildBoardWidgetSandboxPath(
      document("granted", [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ]),
    );
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");
    const csp = decodeSandboxHostCsp(encoded);

    expect(csp).toEqual({
      connectDomains: [
        "https://api.open-meteo.com",
        "https://status.example:8443",
        "https://[2001:db8::1]:9443",
      ],
      blockDescendantFrames: true,
      resourceDomains: [...WIDGET_CDN_ORIGINS],
    });
    expect(buildSandboxHostDocument(csp).headers["Content-Security-Policy"]).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
    expect(
      buildBoardWidgetContentSecurityPolicy(document("granted", csp?.connectDomains)),
    ).toContain(
      "connect-src https://api.open-meteo.com https://status.example:8443 https://[2001:db8::1]:9443",
    );
  });

  it("preserves registered resource origins alongside the widget CDNs without granting fetch", () => {
    const widget = {
      ...document("pending"),
      resourceOrigins: ["https://plugin-assets.example", "https://cdn.jsdelivr.net"],
    };
    const path = buildBoardWidgetSandboxPath(widget);
    const csp = decodeSandboxHostCsp(
      new URL(path, "https://sandbox.example").searchParams.get("csp"),
    );

    expect(csp?.resourceDomains).toEqual([...WIDGET_CDN_ORIGINS, "https://plugin-assets.example"]);
    expect(csp?.connectDomains).toBeUndefined();
    const policy = buildBoardWidgetContentSecurityPolicy(widget);
    expect(policy).toContain("https://plugin-assets.example");
    expect(policy).toContain("connect-src 'none'");
  });

  it("adds the requested descendant-frame guard before resetting document port offers", () => {
    const proxy = buildSandboxHostDocument({ blockDescendantFrames: true }).html;
    const genericProxy = buildSandboxHostDocument().html;

    expect(proxy).toContain("const blockDescendantFrames = true");
    expect(proxy).toContain("sandbox descendant browsing contexts are disabled");
    expect(proxy).toContain('lock(Document.prototype,\\"createElement\\"');
    expect(proxy).toContain('wrapSetter(Element.prototype,\\"innerHTML\\"');
    expect(proxy).toContain('wrapMethod(Element.prototype,\\"setHTMLUnsafe\\"');
    const guardedHtmlIndex = proxy.indexOf("const guardedHtml = guardDocument(params.html)");
    expect(guardedHtmlIndex).toBeGreaterThan(-1);
    expect(proxy.indexOf("widgetPortsOffered.clear()", guardedHtmlIndex)).toBeGreaterThan(
      guardedHtmlIndex,
    );
    expect(proxy).toContain("const apply=Reflect.apply");
    expect(proxy).toContain('if (html.slice(index, index + 4) !== "<!--") break');
    expect(proxy).toContain('const commentEnd = html.indexOf("-->", index + 4)');
    expect(genericProxy).toContain("const blockDescendantFrames = false");
    expect(genericProxy).not.toContain('lock(Document.prototype,\\"createElement\\"');
  });

  it("blocks scripted popups regardless of whether descendant-frame hardening is enabled", () => {
    const path = buildBoardWidgetSandboxPath(document("pending"));
    const encoded = new URL(path, "https://sandbox.example").searchParams.get("csp");
    const csp = decodeSandboxHostCsp(encoded);

    expect(csp?.blockDescendantFrames).toBe(true);
    for (const { html: proxy } of [buildSandboxHostDocument(csp), buildSandboxHostDocument()]) {
      expect(proxy).toContain(
        'frame.setAttribute("sandbox", allowScripts ? "allow-scripts allow-forms" : "")',
      );
      expect(proxy).not.toContain("allow-popups");
    }
  });
});
