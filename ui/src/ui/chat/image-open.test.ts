import { describe, expect, it } from "vitest";
import { resolveSafeImageOpenUrl } from "./image-open.ts";

describe("resolveSafeImageOpenUrl", () => {
  const baseHref = "https://openclaw.ai/chat";

  it("allows absolute https URLs", () => {
    expect(resolveSafeImageOpenUrl("https://example.com/a.png?x=1#y", baseHref)).toBe(
      "https://example.com/a.png?x=1#y",
    );
  });

  it("allows relative URLs resolved against the current origin", () => {
    expect(resolveSafeImageOpenUrl("/assets/pic.png", baseHref)).toBe(
      "https://openclaw.ai/assets/pic.png",
    );
  });

  it("allows blob URLs", () => {
    expect(resolveSafeImageOpenUrl("blob:https://openclaw.ai/abc-123", baseHref)).toBe(
      "blob:https://openclaw.ai/abc-123",
    );
  });

  it("allows data image URLs", () => {
    expect(resolveSafeImageOpenUrl("data:image/png;base64,iVBORw0KGgo=", baseHref)).toBe(
      "data:image/png;base64,iVBORw0KGgo=",
    );
  });

  it("rejects non-image data URLs", () => {
    expect(
      resolveSafeImageOpenUrl("data:text/html,<script>alert(1)</script>", baseHref),
    ).toBeNull();
  });

  it("rejects javascript URLs", () => {
    expect(resolveSafeImageOpenUrl("javascript:alert(1)", baseHref)).toBeNull();
  });

  it("rejects file URLs", () => {
    expect(resolveSafeImageOpenUrl("file:///tmp/x.png", baseHref)).toBeNull();
  });

  it("rejects empty values", () => {
    expect(resolveSafeImageOpenUrl("   ", baseHref)).toBeNull();
  });
});
