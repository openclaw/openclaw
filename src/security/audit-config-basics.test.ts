import { describe, expect, it } from "vitest";
import { collectMinimalProfileOverrideFindings } from "./audit-extra.sync.js";
import { collectElevatedFindings } from "./audit.js";

describe("security audit config basics", () => {
  it("flags agent profile overrides when global tools.profile is minimal", () => {
    const findings = collectMinimalProfileOverrideFindings({
      tools: {
        profile: "minimal",
      },
      agents: {
        list: [
          {
            id: "owner",
            tools: { profile: "full" },
          },
        ],
      },
    });

    expect(
      findings.some(
        (finding) =>
          finding.checkId === "tools.profile_minimal_overridden" && finding.severity === "warn",
      ),
    ).toBe(true);
  });

  it("flags tools.elevated allowFrom wildcard as critical", () => {
    const findings = collectElevatedFindings({
      tools: {
        elevated: {
          allowFrom: { whatsapp: ["*"] },
        },
      },
    });

    expect(
      findings.some(
        (finding) =>
          finding.checkId === "tools.elevated.allowFrom.whatsapp.wildcard" &&
          finding.severity === "critical",
      ),
    ).toBe(true);
  });
});
