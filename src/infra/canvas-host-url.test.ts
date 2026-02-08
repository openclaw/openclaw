import { describe, expect, it } from "vitest";
import { resolveCanvasHostUrl } from "./canvas-host-url.js";

describe("resolveCanvasHostUrl", () => {
  it("returns undefined when canvasPort is not set", () => {
    expect(resolveCanvasHostUrl({})).toBeUndefined();
  });

  it("returns advertisedUrl origin without trailing slash", () => {
    expect(
      resolveCanvasHostUrl({ canvasPort: 18793, advertisedUrl: "https://gateway.example.com/" }),
    ).toBe("https://gateway.example.com");
  });

  it("strips path from advertisedUrl", () => {
    expect(
      resolveCanvasHostUrl({
        canvasPort: 18793,
        advertisedUrl: "https://gateway.example.com/path/to/thing",
      }),
    ).toBe("https://gateway.example.com");
  });

  it("preserves non-standard port in advertisedUrl", () => {
    expect(
      resolveCanvasHostUrl({
        canvasPort: 18793,
        advertisedUrl: "https://gateway.example.com:8443",
      }),
    ).toBe("https://gateway.example.com:8443");
  });

  it("normalizes standard https port in advertisedUrl", () => {
    expect(
      resolveCanvasHostUrl({ canvasPort: 18793, advertisedUrl: "https://gateway.example.com:443" }),
    ).toBe("https://gateway.example.com");
  });

  it("falls back to host resolution when advertisedUrl is not set", () => {
    expect(resolveCanvasHostUrl({ canvasPort: 18793, localAddress: "192.168.1.100" })).toBe(
      "http://192.168.1.100:18793",
    );
  });
});
