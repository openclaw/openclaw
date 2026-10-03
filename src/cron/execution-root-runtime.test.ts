import { describe, expect, it } from "vitest";
import {
  assertCronExecutionRootRuntime,
  supportsCronExecutionRoot,
} from "./execution-root-runtime.js";
import { assertCronRuntimeAuthorityCandidate } from "./isolated-agent/run-admission.js";
import { normalizeCronRuntimeAuthority } from "./runtime-authority.js";

describe("required execution root admission", () => {
  it.each([
    { root: "/workshop", runtime: "codex", cli: false, supported: true },
    { root: "/workshop", runtime: "unsupported", cli: false, supported: false },
    { root: undefined, runtime: "unsupported", cli: false, supported: false },
    { root: "/workshop", runtime: "cli", cli: true, supported: true },
  ])("enforces execution root admission: $runtime, $root", ({ root, runtime, cli, supported }) => {
    expect(supportsCronExecutionRoot(runtime, cli)).toBe(supported);
    const admission = () => assertCronExecutionRootRuntime(root, runtime, cli);
    if (root && !supported) {
      expect(admission).toThrow("enforces the Workshop root");
    } else {
      expect(admission).not.toThrow();
    }
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
