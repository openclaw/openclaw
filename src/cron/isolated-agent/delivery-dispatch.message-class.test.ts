import { describe, expect, it } from "vitest";
import { cronJobDefaultsToOperatorOnly } from "./delivery-dispatch.js";

// Phase 4 Discord Surface Overhaul: cron operator-only defaulting.
//
// Internal ops cron jobs (gateway keep-alive watchdog, ACP completion
// reporter) must NOT speak into user-facing channels. They default to
// `notifyPolicy: "operator_only"` when their id starts with one of the
// well-known prefixes. The delivery-dispatch layer consults
// `cronJobDefaultsToOperatorOnly` to decide whether to flag the outbound
// send for `planDelivery` to reroute (operator channel configured) or
// suppress (no operator channel).

describe("Phase 4 cron operator-only defaulting", () => {
  it("classifies main-auto-continue-* jobs as operator-only", () => {
    expect(cronJobDefaultsToOperatorOnly("main-auto-continue-watchdog")).toBe(true);
    expect(cronJobDefaultsToOperatorOnly("main-auto-continue-nudge-1")).toBe(true);
  });

  it("classifies acp-completion-* jobs as operator-only", () => {
    expect(cronJobDefaultsToOperatorOnly("acp-completion-reporter")).toBe(true);
    expect(cronJobDefaultsToOperatorOnly("acp-completion-001")).toBe(true);
  });

  it("does not classify arbitrary user cron jobs as operator-only", () => {
    expect(cronJobDefaultsToOperatorOnly("daily-summary")).toBe(false);
    expect(cronJobDefaultsToOperatorOnly("nightly-reporter")).toBe(false);
    expect(cronJobDefaultsToOperatorOnly("")).toBe(false);
  });

  it("matches only on prefix so substrings do not leak operator routing", () => {
    expect(cronJobDefaultsToOperatorOnly("user-main-auto-continue-clone")).toBe(false);
    expect(cronJobDefaultsToOperatorOnly("x-acp-completion-reporter")).toBe(false);
  });
});
