import { describe, expect, it } from "vitest";
import { scrubDoctorErrorMessage } from "./doctor-error-message.js";

describe("scrubDoctorErrorMessage", () => {
  it("keeps word separation for multi-line errors", () => {
    const scrubbed = scrubDoctorErrorMessage(
      new Error("Gateway not reachable.\nStart it with `openclaw gateway run`.\r\n\tCheck status."),
    );
    expect(scrubbed).toBe(
      "Gateway not reachable. Start it with `openclaw gateway run`. Check status.",
    );
  });

  it("appends wrapped causes once, skipping ones the message already states", () => {
    const repeated = new Error("database is locked");
    const scrubbed = scrubDoctorErrorMessage(
      new Error("Check failed.", {
        cause: new Error("Store refused: database is locked", { cause: repeated }),
      }),
    );
    expect(scrubbed).toBe("Check failed. Cause: Store refused: database is locked");
  });

  it("drops non-whitespace control characters and caps length", () => {
    const scrubbed = scrubDoctorErrorMessage(`a\u0000b\u0007c ${"x".repeat(300)}`);
    expect(scrubbed.startsWith("abc x")).toBe(true);
    expect(scrubbed.endsWith("...")).toBe(true);
    expect(scrubbed.length).toBeLessThanOrEqual(256);
  });
});
