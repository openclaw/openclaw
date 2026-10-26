import { describe, expect, it } from "vitest";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { createCanonicalAgentConfigFixture } from "../test-utils/config-roster.js";
import { applyWizardMetadata } from "./onboard-helpers.js";

describe("applyWizardMetadata", () => {
  it("preserves the migrated legacy owner across the config replacement", () => {
    const cfg = createCanonicalAgentConfigFixture({
      agents: {
        list: [{ id: "main", default: true }, { id: "ops" }],
      },
    }).config;
    expect(tryResolveLegacyCompatibilityAgentId(cfg)).toBe("main");

    const result = applyWizardMetadata(cfg, { command: "doctor", mode: "local" });

    expect(result).not.toBe(cfg);
    expect(tryResolveLegacyCompatibilityAgentId(result)).toBe("main");
  });
});
