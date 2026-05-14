import { describe, expect, it } from "vitest";
import { isDangerousHostEnvOverrideVarName, sanitizeSystemRunEnvOverrides } from "./sandbox.js";

describe("plugin SDK sandbox exports", () => {
  it("re-exports host env override guards", () => {
    expect(isDangerousHostEnvOverrideVarName("HOME")).toBe(true);
    expect(isDangerousHostEnvOverrideVarName("OPENCLAW_SAFE_FLAG")).toBe(false);
  });

  it("re-exports system-run env override sanitization", () => {
    expect(
      sanitizeSystemRunEnvOverrides({
        shellWrapper: true,
        overrides: { LANG: "en_US.UTF-8", PATH: "/tmp/bin", TERM: "xterm-256color" },
      }),
    ).toStrictEqual({ LANG: "en_US.UTF-8", TERM: "xterm-256color" });
  });
});
