import { describe, expect, it } from "vitest";
import { CRON_AGENT_SELECTION_REQUIRED_MESSAGE } from "../../cron/agent-id.js";
import { assertCheckSupport, assertSupportedJobSpec } from "../../cron/service/jobs-validation.js";
import { isCronInvalidRequestError } from "./cron-error-classification.js";

describe("isCronInvalidRequestError", () => {
  it.each([
    { sessionTarget: "main", payload: { kind: "command" } },
    { sessionTarget: "isolated", payload: { kind: "systemEvent" } },
    { sessionTarget: "current", payload: { kind: "systemEvent" } },
    { sessionTarget: "session:agent:main:conversation", payload: { kind: "systemEvent" } },
  ] as const)("classifies target/payload guidance as invalid input: $sessionTarget", (job) => {
    let error: unknown;
    try {
      assertSupportedJobSpec(job);
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect(isCronInvalidRequestError(error)).toBe(true);
  });

  it("classifies unresolved agent ownership as an actionable invalid request", () => {
    expect(isCronInvalidRequestError(new Error(CRON_AGENT_SELECTION_REQUIRED_MESSAGE))).toBe(true);
  });

  it.each([
    { check: { script: "const x = ;" } },
    { check: { script: " " } },
    { payload: { kind: "command", argv: ["true"] } },
    { check: undefined, payload: { kind: "none" } },
    { schedule: { kind: "at", at: "2030-01-01T00:00:00Z" } },
    { schedule: { kind: "every", everyMs: 1 } },
    { check: { script: "return {};", timeoutSeconds: 0 } },
    { check: { script: "return {};", toolBudget: 201 } },
  ] satisfies Partial<Parameters<typeof assertCheckSupport>[0]>[])(
    "classifies authored check validation %j",
    (overrides) => {
      let error: unknown;
      try {
        assertCheckSupport(
          {
            schedule: { kind: "every", everyMs: 60_000 },
            payload: { kind: "agentTurn", message: "Handle changes" },
            check: { script: "return {};" },
            ...overrides,
          },
          { validateAuthoredCheck: true },
        );
      } catch (cause) {
        error = cause;
      }
      expect(error).toBeInstanceOf(Error);
      expect(isCronInvalidRequestError(error)).toBe(true);
    },
  );

  it("classifies disabled check authoring without classifying runtime failures", () => {
    let error: unknown;
    try {
      assertCheckSupport(
        {
          schedule: { kind: "every", everyMs: 60_000 },
          payload: { kind: "none" },
          check: { script: "return {};" },
        },
        { validateAuthoredCheck: true, cronConfig: { triggers: { enabled: false } } },
      );
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(Error);
    expect(isCronInvalidRequestError(error)).toBe(true);
    expect(isCronInvalidRequestError(new Error("cron check runtime failed"))).toBe(false);
  });

  it("classifies ambiguous announce delivery validation", () => {
    expect(
      isCronInvalidRequestError(
        new Error(
          "cron announce delivery requires an explicit channel when multiple channels are configured (discord, reef)",
        ),
      ),
    ).toBe(true);
  });
});
