import { describe, expect, it } from "vitest";
import { buildControlUiCspHeader } from "./control-ui-csp.js";

describe("buildControlUiCspHeader", () => {
  it("blocks inline scripts while allowing inline styles", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });

  it("allows trusted frame ancestors for Playground embedding", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain(
      "frame-ancestors 'self' https://app.hanzo.bot https://bot.hanzo.ai https://hanzo.app",
    );
  });

  it("allows Google Fonts stylesheet and font files", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("font-src 'self' https://fonts.gstatic.com");
    expect(csp).toContain("style-src 'self' 'unsafe-inline' https://fonts.googleapis.com");
  });

  it("allows frame-src for VNC viewer iframe", () => {
    const csp = buildControlUiCspHeader();
    expect(csp).toContain("frame-src 'self'");
  });

  it("includes IAM server in connect-src when provided", () => {
    const csp = buildControlUiCspHeader("https://hanzo.id");
    expect(csp).toContain("connect-src 'self' ws: wss: https://hanzo.id");
  });
});
