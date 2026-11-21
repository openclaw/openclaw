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
    const cases: [string[], string[], string[]][] = [
      [["system.*", "system.runx"], ["system.*", "system.runx", "did you mean", "system.run"], []],
      [["system.run.prep"], ["system.run.prep", "did you mean", "system.run.prepare"], []],
      [["zzzzzzzzzzzzzz"], ["zzzzzzzzzzzzzz"], ["did you mean"]],
      [
        ["camera.snap", "screen.record", "camera.snapp", "system.*"],
        ["camera.snapp", "system.*", "did you mean", "camera.snap"],
        ["screen.record"],
      ],
    ];
    for (const [deny, included, excluded] of cases) {
      const findings = collectNodeDenyCommandPatternFindings(config({ deny }));
      const finding = findings.find(
        (entry) => entry.checkId === "gateway.nodes.deny_commands_ineffective",
      );
      expect(finding, deny.join(", ")).toMatchObject({ severity: "warn" });
      for (const text of included) {
        expect(finding?.detail).toContain(text);
      }
      for (const text of excluded) {
        expect(finding?.detail).not.toContain(text);
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
    const commands = ["camera.snap", "screen.record", "health.summary"];
    const cases: [OpenClawConfig, "warn" | "critical" | undefined][] = [
      [config({ allow: commands }, "loopback"), "warn"],
      [config({ allow: commands }, "lan"), "critical"],
      [config({ allow: commands.slice(0, 2), deny: commands.slice(0, 2) }), undefined],
    ];
    for (const [cfg, severity] of cases) {
      const findings = collectNodeDangerousAllowCommandFindings(cfg);
      const finding = findings.find(
        (entry) => entry.checkId === "gateway.nodes.allow_commands_dangerous",
      );
      if (!severity) {
        expect(finding).toBeUndefined();
        continue;
      }
      expect(finding).toMatchObject({ severity });
      for (const text of commands) {
        expect(finding?.detail).toContain(text);
      }
    }
  });
});
