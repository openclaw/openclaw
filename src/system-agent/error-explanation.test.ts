import { expect, it } from "vitest";
import { explainPastedSystemAgentError } from "./error-explanation.js";

it.each([
  [
    "gateway closed (1008): unauthorized: gateway token mismatch (use this gateway's gateway.auth.token)",
    "Check that the client is pointing at the intended Gateway",
  ],
  ["AUTH_TOKEN_MISMATCH", "Check that the client is pointing at the intended Gateway"],
  ["Context overflow: prompt too large for the model.", "Try a shorter request in a fresh chat"],
])("explains the known signature %s", (error, nextStep) => {
  expect(explainPastedSystemAgentError(`Explain error:\n${error}`)).toContain(nextStep);
});

it.each([
  ["empty", "", "exact error line"],
  ["generic authentication", "401 Unauthorized", "what you were doing"],
  [
    "incidental context wording",
    "Gateway timeout while checking maximum context length",
    "your OpenClaw version",
  ],
  [
    "conflicting",
    "OpenClaw config is invalid\nAUTH_TOKEN_MISMATCH",
    "more than one recognizable error",
  ],
  [
    "earlier attempt",
    "Error: Gateway connection timed out\nPrevious attempt:\nAUTH_TOKEN_MISMATCH",
    "There isn't enough information",
  ],
  ["oversized", `AUTH_TOKEN_MISMATCH\n${"x".repeat(8_000)}`, "paste is too long"],
])("asks for more useful input for a %s paste", (_case, error, guidance) => {
  const reply = explainPastedSystemAgentError(`explain error: ${error}`);
  expect(reply).toContain(guidance);
  expect(reply).toContain("`explain error:`");
  expect(reply).not.toContain("Likely cause:");
});

it("leaves normal chat and unprefixed error text alone", () => {
  expect(
    explainPastedSystemAgentError("Can you explain error: something is broken?"),
  ).toBeUndefined();
  expect(explainPastedSystemAgentError("OpenClaw config is invalid")).toBeUndefined();
});
