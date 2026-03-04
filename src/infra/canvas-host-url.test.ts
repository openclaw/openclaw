import { describe, expect, it } from "vitest";
import { resolveCanvasHostUrl } from "./canvas-host-url.js";

describe("resolveCanvasHostUrl", () => {
  it("prefers x-forwarded-host when websocket host is internal", () => {
    const resolved = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "gateway:18789",
      forwardedHost: "openclaw.example.com",
      forwardedProto: "https",
      localAddress: "127.0.0.1",
    });

    expect(resolved).toBe("https://openclaw.example.com:443");
  });

  it("uses the first forwarded host token and keeps explicit port", () => {
    const resolved = resolveCanvasHostUrl({
      canvasPort: 18789,
      requestHost: "gateway:18789",
      forwardedHost: "openclaw.example.com:8443, proxy.internal",
      forwardedProto: "https,http",
    });

    expect(resolved).toBe("https://openclaw.example.com:8443");
  });
});
