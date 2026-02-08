import { describe, expect, it } from "vitest";
import { parseWsClose } from "./connection-close";

describe("parseWsClose", () => {
  it("detects PAIRING_REQUIRED via exact sentinel", () => {
    expect(parseWsClose(1008, "PAIRING_REQUIRED")).toEqual({
      code: 1008,
      category: "PAIRING_REQUIRED",
      safeReason: "PAIRING_REQUIRED",
    });
  });

  it("detects PAIRING_REQUIRED via JSON sentinel", () => {
    expect(parseWsClose(1008, JSON.stringify({ error: "PAIRING_REQUIRED" }))).toEqual({
      code: 1008,
      category: "PAIRING_REQUIRED",
      safeReason: "PAIRING_REQUIRED",
    });
  });

  it("avoids false positives on other 1008 reasons", () => {
    expect(parseWsClose(1008, "SOME_OTHER_POLICY").category).toBe("UNKNOWN_POLICY");
    expect(parseWsClose(1008, '{"error":"NOT_IT"}').category).toBe("UNKNOWN_POLICY");
  });

  it("categorizes non-1008 closes as OTHER", () => {
    expect(parseWsClose(1011, "PAIRING_REQUIRED").category).toBe("OTHER");
  });
});
