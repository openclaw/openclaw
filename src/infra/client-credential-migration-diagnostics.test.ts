import { expect, it } from "vitest";
import { redactPublicSupportDiagnosticLine } from "../logging/diagnostic-support-redaction.js";

it("does not publish arbitrary text following a lookalike socket diagnostic", () => {
  const context = { env: {}, stateDir: "" };
  expect(
    redactPublicSupportDiagnosticLine(
      "Client credential socket material is invalid. private-value",
      context,
    ),
  ).toBe("[redacted-diagnostic]");
});
