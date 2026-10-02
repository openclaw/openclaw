import { describe, expect, it } from "vitest";
import {
  assertCronExecutionRootRuntime,
  supportsCronExecutionRoot,
} from "./execution-root-runtime.js";
import { assertCronRuntimeAuthorityCandidate } from "./isolated-agent/run-admission.js";
import { normalizeCronRuntimeAuthority } from "./runtime-authority.js";

describe("required execution root admission", () => {
  it("admits the enforcing Codex route without making unsupported runtimes eligible", () => {
    expect(supportsCronExecutionRoot("codex", false)).toBe(true);
    expect(() => assertCronExecutionRootRuntime("/workshop", "codex", false)).not.toThrow();
    expect(supportsCronExecutionRoot("unsupported", false)).toBe(false);
    expect(() => assertCronExecutionRootRuntime("/workshop", "unsupported", false)).toThrow(
      "enforces the Workshop root",
    );
  });

  it("keeps unrooted and existing rooted CLI admission unchanged", () => {
    expect(() => assertCronExecutionRootRuntime(undefined, "unsupported", false)).not.toThrow();
    expect(() => assertCronExecutionRootRuntime("/workshop", "cli", true)).not.toThrow();
  });

  it("does not replace captured Codex authority with another rooted runtime or CLI", () => {
    const authority = normalizeCronRuntimeAuthority({
      version: 1,
      runtimeId: "codex",
      namespace: "codex.apps",
      payload: {},
    });
    expect(authority).toBeDefined();
    expect(() =>
      assertCronRuntimeAuthorityCandidate({
        authority,
        candidateRuntime: "codex",
        cliExecution: false,
      }),
    ).not.toThrow();
    for (const candidate of [
      { candidateRuntime: "openclaw", cliExecution: false },
      { candidateRuntime: "codex", cliExecution: true },
    ]) {
      expect(() => assertCronRuntimeAuthorityCandidate({ authority, ...candidate })).toThrow(
        "authority captured for the codex runtime",
      );
    }
  });
});
