import { describe, expect, it } from "vitest";
import { buildControlUiCspHeader } from "./control-ui-csp.js";

describe("buildControlUiCspHeader", () => {
  it("blocks inline scripts while allowing inline styles", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
  });

  it("appends validated extra source entries", () => {
    const csp = buildControlUiCspHeader({
      extraSources: {
        imgSrc: ["https://cdn.example.com", "https://*.images.example.com"],
        fontSrc: ["https://fonts.gstatic.com"],
        connectSrc: ["wss://ws.example.com"],
        styleSrcElem: ["https://fonts.googleapis.com"],
        workerSrc: ["https://worker.example.com"],
      },
    });
    expect(csp).toContain(
      "img-src 'self' data: https: https://cdn.example.com https://*.images.example.com",
    );
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("connect-src 'self' ws: wss: wss://ws.example.com");
    expect(csp).toContain("style-src-elem 'self' https://fonts.googleapis.com");
    expect(csp).toContain("worker-src 'self' blob: https://worker.example.com");
  });

  it("ignores malformed and duplicate extra sources", () => {
    const csp = buildControlUiCspHeader({
      extraSources: {
        scriptSrc: [
          "https://assets.example.com/path",
          "https://assets.example.com",
          "'self'",
          "https://assets.example.com",
          "bad token",
          "https://safe.example.com;script-src 'unsafe-inline'",
        ],
      },
    });
    expect(csp).toContain("script-src 'self' https://assets.example.com");
    expect(csp).not.toContain("script-src 'self' 'self'");
    expect(csp).not.toContain("bad token");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });
});
