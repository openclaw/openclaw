import { describe, expect, it, vi } from "vitest";
import { parseRelaySmokeTest, runRelaySmokeTest } from "./relay-smoke.js";

vi.mock("../web/qr-image.js", () => ({
  renderQrPngBase64: vi.fn(async () => "base64"),
}));

describe("parseRelaySmokeTest", () => {
  it("parses --smoke qr", () => {
    expect(parseRelaySmokeTest(["--smoke", "qr"], {})).toBe("qr");
  });

  it("rejects --smoke without a value", () => {
    expect(() => parseRelaySmokeTest(["--smoke"], {})).toThrow(
      "Missing value for --smoke (expected: qr)",
    );
  });

  it("rejects --smoke when the next arg is another flag", () => {
    expect(() => parseRelaySmokeTest(["--smoke", "--smoke-qr"], {})).toThrow(
      "Missing value for --smoke (expected: qr)",
    );
  });

  it("parses --smoke-qr", () => {
    expect(parseRelaySmokeTest(["--smoke-qr"], {})).toBe("qr");
  });

  it("parses env var smoke mode only when no args", () => {
    expect(parseRelaySmokeTest([], { OPENCLAW_SMOKE_QR: "1" })).toBe("qr");
    expect(parseRelaySmokeTest(["send"], { OPENCLAW_SMOKE_QR: "1" })).toBe(null);
  });

  it("supports OPENCLAW_SMOKE=qr only when no args", () => {
    expect(parseRelaySmokeTest([], { OPENCLAW_SMOKE: "qr" })).toBe("qr");
    expect(parseRelaySmokeTest(["send"], { OPENCLAW_SMOKE: "qr" })).toBe(null);
  });

  it("rejects unknown smoke values", () => {
    expect(() => parseRelaySmokeTest(["--smoke", "nope"], {})).toThrow("Unknown smoke test");
  });

  it("prefers explicit --smoke over env vars", () => {
    expect(parseRelaySmokeTest(["--smoke", "qr"], { OPENCLAW_SMOKE: "nope" })).toBe("qr");
  });
});

describe("runRelaySmokeTest", () => {
  it("runs qr smoke test", async () => {
    await runRelaySmokeTest("qr");
    const mod = await import("../web/qr-image.js");
    expect(mod.renderQrPngBase64).toHaveBeenCalledWith("smoke-test");
  });
});
