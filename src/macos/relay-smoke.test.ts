import { describe, expect, it, vi } from "vitest";
import { parseRelaySmokeTest, runRelaySmokeTest } from "./relay-smoke.js";

vi.mock("../web/qr-image.js", () => ({
  renderQrPngBase64: vi.fn(async () => "base64"),
}));

describe("parseRelaySmokeTest", () => {
  it("parses --smoke qr", () => {
    expect(parseRelaySmokeTest(["--smoke", "qr"], {})).toBe("qr");
  });

  it("parses --smoke-qr", () => {
    expect(parseRelaySmokeTest(["--smoke-qr"], {})).toBe("qr");
  });

  it("parses env var smoke mode only when no args", () => {
    expect(parseRelaySmokeTest([], { CLAWDBOT_SMOKE_QR: "1" })).toBe("qr");
    expect(parseRelaySmokeTest(["send"], { CLAWDBOT_SMOKE_QR: "1" })).toBe(null);
  });

  it("rejects unknown smoke values", () => {
    expect(() => parseRelaySmokeTest(["--smoke", "nope"], {})).toThrow("Unknown smoke test");
  });
});

describe("runRelaySmokeTest", () => {
  it("runs qr smoke test", async () => {
    await runRelaySmokeTest("qr");
    const mod = await import("../web/qr-image.js");
    expect(mod.renderQrPngBase64).toHaveBeenCalledWith("smoke-test");
  });
});
