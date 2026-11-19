import { expect, it } from "vitest";
import { configValidationIssuesToHealthFindings } from "./doctor-config-validation-findings.js";

it("directs users to the config file when an invalid setting has no repair hint", () => {
  const findings = configValidationIssuesToHealthFindings([
    { path: "gateway.port", message: "Expected a number" },
  ]);

  expect(findings).toEqual([
    expect.objectContaining({
      path: "gateway.port",
      fixHint: expect.stringContaining(" config file`"),
    }),
  ]);
  expect(findings[0]?.fixHint).not.toContain("config unset");
});
