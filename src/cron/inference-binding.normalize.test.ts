import { describe, expect, it } from "vitest";
import {
  describeCronInferenceBinding,
  normalizeCronInferenceBinding,
  resolveCronRuntimeSessionEntry,
} from "./inference-binding.js";

const binding = {
  version: 1 as const,
  provider: "anthropic",
  profileId: "anthropic:manual",
  authorizationId: "a".repeat(64),
  authRequirement: "subscription" as const,
  source: "user" as const,
};

describe("cron inference binding runtime", () => {
  it("keeps a captured runtime and accepts bindings recorded before it", () => {
    expect(normalizeCronInferenceBinding({ ...binding, runtime: "claude-cli" })).toEqual({
      ...binding,
      runtime: "claude-cli",
    });
    expect(normalizeCronInferenceBinding(binding)).toEqual(binding);
    expect(() => normalizeCronInferenceBinding({ ...binding, runtime: " " })).toThrow(
      /Invalid automation inference binding/,
    );
  });

  it("runs on the captured runtime instead of the cron session's copied override", () => {
    const entry = { agentRuntimeOverride: "claude-cli", agentHarnessId: "claude-cli" };
    expect(resolveCronRuntimeSessionEntry({ ...binding, runtime: "openclaw" }, entry)).toEqual({
      agentRuntimeOverride: "openclaw",
    });
    expect(resolveCronRuntimeSessionEntry(binding, entry)).toBe(entry);
    expect(resolveCronRuntimeSessionEntry(undefined, entry)).toBe(entry);
  });

  it("names the account and its captured runtime", () => {
    expect(describeCronInferenceBinding({ ...binding, runtime: "claude-cli" })).toBe(
      "account anthropic:manual on runtime claude-cli",
    );
    expect(describeCronInferenceBinding(binding)).toBe(
      "account anthropic:manual (no recorded runtime)",
    );
  });
});
