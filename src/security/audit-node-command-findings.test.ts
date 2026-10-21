import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectNodeDangerousAllowCommandFindings,
  collectNodeDenyCommandPatternFindings,
} from "./audit-extra.sync.js";

function config(
  commands: NonNullable<NonNullable<OpenClawConfig["gateway"]>["nodes"]>["commands"],
  bind?: NonNullable<OpenClawConfig["gateway"]>["bind"],
): OpenClawConfig {
  return { gateway: { bind, nodes: { commands } } };
}

describe("security audit node command findings", () => {
  it("evaluates ineffective gateway.nodes.commands.deny entries", () => {
    const cases = [
      {
        name: "flags ineffective gateway.nodes.commands.deny entries",
        cfg: config({ deny: ["system.*", "system.runx"] }),
        detailIncludes: ["system.*", "system.runx", "did you mean", "system.run"],
      },
      {
        name: "suggests prefix-matching commands for unknown deny entries",
        cfg: config({ deny: ["system.run.prep"] }),
        detailIncludes: ["system.run.prep", "did you mean", "system.run.prepare"],
      },
      {
        name: "keeps unknown deny entries without suggestions when no close command exists",
        cfg: config({ deny: ["zzzzzzzzzzzzzz"] }),
        detailIncludes: ["zzzzzzzzzzzzzz"],
        detailExcludes: ["did you mean"],
      },
      {
        name: "keeps valid dangerous deny entries out of unknown warnings",
        cfg: config({ deny: ["camera.snap", "screen.record", "camera.snapp", "system.*"] }),
        detailIncludes: ["camera.snapp", "system.*", "did you mean", "camera.snap"],
        detailExcludes: ["screen.record"],
      },
    ] as const;

    for (const testCase of cases) {
      const findings = collectNodeDenyCommandPatternFindings(testCase.cfg);
      const finding = findings.find(
        (entry) => entry.checkId === "gateway.nodes.deny_commands_ineffective",
      );
      expect(finding, testCase.name).toMatchObject({ severity: "warn" });
      for (const text of testCase.detailIncludes) {
        expect(finding?.detail, `${testCase.name}:${text}`).toContain(text);
      }
      for (const text of "detailExcludes" in testCase ? testCase.detailExcludes : []) {
        expect(finding?.detail, `${testCase.name}:${text}`).not.toContain(text);
      }
    }
  });

  it("does not flag valid gateway.nodes.commands.deny entries as ineffective", () => {
    const findings = collectNodeDenyCommandPatternFindings(
      config({
        deny: [
          "camera.snap",
          "camera.clip",
          "screen.record",
          "desktop.stream",
          "sms.send",
          "system.run",
        ],
      }),
    );

    expect(findings).toStrictEqual([]);
  });

  it("evaluates dangerous gateway.nodes.commands.allow findings", () => {
    const cases: Array<{
      name: string;
      cfg: OpenClawConfig;
      expectedSeverity?: "warn" | "critical";
      expectedAbsent?: boolean;
    }> = [
      {
        name: "loopback gateway",
        cfg: config({ allow: ["camera.snap", "screen.record", "health.summary"] }, "loopback"),
        expectedSeverity: "warn",
      },
      {
        name: "lan-exposed gateway",
        cfg: config({ allow: ["camera.snap", "screen.record", "health.summary"] }, "lan"),
        expectedSeverity: "critical",
      },
      {
        name: "denied again suppresses dangerous allow finding",
        cfg: config({
          allow: ["camera.snap", "screen.record"],
          deny: ["camera.snap", "screen.record"],
        }),
        expectedAbsent: true,
      },
    ];

    for (const testCase of cases) {
      const findings = collectNodeDangerousAllowCommandFindings(testCase.cfg);
      const finding = findings.find(
        (entry) => entry.checkId === "gateway.nodes.allow_commands_dangerous",
      );
      if (testCase.expectedAbsent) {
        expect(finding, testCase.name).toBeUndefined();
        continue;
      }
      expect(finding, testCase.name).toMatchObject({ severity: testCase.expectedSeverity });
      for (const text of ["camera.snap", "screen.record", "health.summary"]) {
        expect(finding?.detail, `${testCase.name}:${text}`).toContain(text);
      }
    }
  });
});
