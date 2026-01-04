import { describe, expect, it } from "vitest";

import { renderQrPngBase64 } from "./qr-image.js";

describe("renderQrPngBase64", () => {
  it("renders a PNG data payload", async () => {
    const b64 = await renderQrPngBase64("clawdbot");
    const buf = Buffer.from(b64, "base64");
    expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  });
});
