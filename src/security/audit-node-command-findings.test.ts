import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectNodeDangerousAllowCommandFindings,
  collectNodeDenyCommandPatternFindings,
} from "./audit-extra.sync.js";

function expectDetailText(params: {
  detail: string | null | undefined;
  name: string;
  includes?: readonly string[];
  excludes?: readonly string[];
}) {
  for (const text of params.includes ?? []) {
    expect(params.detail, `${params.name}:${text}`).toContain(text);
  }
  for (const text of params.excludes ?? []) {
    expect(params.detail, `${params.name}:${text}`).not.toContain(text);
  }
}

describe("security audit node command findings", () => {
  it("evaluates ineffective gateway.nodes.denyCommands entries", () => {
    const cases = [
      {
        name: "flags ineffective gateway.nodes.denyCommands entries",
        cfg: {
          gateway: {
            nodes: {
              denyCommands: ["system.*", "system.runx"],
            },
          },
        } satisfies OpenClawConfig,
        detailIncludes: ["system.*", "system.runx", "did you mean", "system.run"],
      },
      {
        name: "suggests prefix-matching commands for unknown denyCommands entries",
        cfg: {
          gateway: {
            nodes: {
              denyCommands: ["system.run.prep"],
            },
          },
        } satisfies OpenClawConfig,
        detailIncludes: ["system.run.prep", "did you mean", "system.run.prepare"],
      },
      {
        name: "keeps unknown denyCommands entries without suggestions when no close command exists",
        cfg: {
          gateway: {
            nodes: {
              denyCommands: ["zzzzzzzzzzzzzz"],
            },
          },
        } satisfies OpenClawConfig,
        detailIncludes: ["zzzzzzzzzzzzzz"],
        detailExcludes: ["did you mean"],
      },
    ] as const;

    for (const testCase of cases) {
      const findings = collectNodeDenyCommandPatternFindings(testCase.cfg);
      const finding = findings.find(
        (entry) => entry.checkId === "gateway.nodes.deny_commands_ineffective",
      );
      expect(finding?.severity, testCase.name).toBe("warn");
      expectDetailText({
        detail: finding?.detail,
        name: testCase.name,
        includes: testCase.detailIncludes,
        excludes: "detailExcludes" in testCase ? testCase.detailExcludes : [],
      });
    }
  });

  it("evaluates dangerous gateway.nodes.allowCommands findings", () => {
    const cases = [
      {
        name: "loopback gateway",
        cfg: {
          gateway: {
            bind: "loopback",
            nodes: { allowCommands: ["camera.snap", "screen.record"] },
          },
        } satisfies OpenClawConfig,
        expectedSeverity: "warn" as const,
      },
      {
        name: "lan-exposed gateway",
        cfg: {
          gateway: {
            bind: "lan",
            nodes: { allowCommands: ["camera.snap", "screen.record"] },
          },
        } satisfies OpenClawConfig,
        expectedSeverity: "critical" as const,
      },
      {
        name: "denied again suppresses dangerous allowCommands finding",
        cfg: {
          gateway: {
            nodes: {
              allowCommands: ["camera.snap", "screen.record"],
              denyCommands: ["camera.snap", "screen.record"],
            },
          },
        } satisfies OpenClawConfig,
        expectedAbsent: true,
      },
    ] as const;

    for (const testCase of cases) {
      const findings = collectNodeDangerousAllowCommandFindings(testCase.cfg);
      const finding = findings.find(
        (entry) => entry.checkId === "gateway.nodes.allow_commands_dangerous",
      );
      if ("expectedAbsent" in testCase && testCase.expectedAbsent) {
        expect(finding, testCase.name).toBeUndefined();
        continue;
      }
      expect(finding?.severity, testCase.name).toBe(testCase.expectedSeverity);
      expectDetailText({
        detail: finding?.detail,
        name: testCase.name,
        includes: ["camera.snap", "screen.record"],
      });
    }
  });
});
