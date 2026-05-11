import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  CORE_DIAGNOSTIC_CHECKS,
  registerCoreDiagnosticChecks,
  resetCoreDiagnosticChecksForTest,
} from "./core-diagnostics.js";
import {
  clearDiagnosticChecksForTest,
  listDiagnosticChecks,
  registerDiagnosticCheck,
} from "./diagnostic-registry.js";

describe("registerCoreDiagnosticChecks", () => {
  let tmp: string | undefined;

  beforeEach(() => {
    clearDiagnosticChecksForTest();
    resetCoreDiagnosticChecksForTest();
  });

  afterEach(async () => {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("registers the built-in diagnostic checks once", () => {
    registerCoreDiagnosticChecks();
    registerCoreDiagnosticChecks();

    expect(listDiagnosticChecks().map((check) => check.id)).toEqual([
      "core/lint/gateway-config",
      "core/lint/command-owner",
      "core/lint/workspace-status",
      "core/lint/skills-readiness",
      "core/lint/final-config-validation",
    ]);
  });

  it("can retry after a duplicate registration failure is cleared", () => {
    registerDiagnosticCheck({
      id: "core/lint/gateway-config",
      kind: "core",
      description: "duplicate",
      async detect() {
        return [];
      },
    });

    expect(() => registerCoreDiagnosticChecks()).toThrow("diagnostic check already registered");

    clearDiagnosticChecksForTest();
    registerCoreDiagnosticChecks();

    expect(listDiagnosticChecks()).toHaveLength(5);
  });

  it("reports unavailable allowed skills", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-skills-"));
    const skillDir = join(tmp, "skills", "missing-tool");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      join(skillDir, "SKILL.md"),
      `---
name: missing-tool
description: Missing tool
metadata: '{"openclaw":{"requires":{"bins":["openclaw-test-missing-skill-bin"]}}}'
---

# Missing tool
`,
      "utf-8",
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmp,
          skills: ["missing-tool"],
        },
      },
    };
    const check = CORE_DIAGNOSTIC_CHECKS.find((entry) => entry.id === "core/lint/skills-readiness");

    const findings = await check?.detect({
      mode: "lint",
      runtime: { log() {}, error() {}, exit() {} },
      cfg,
      cwd: tmp,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/lint/skills-readiness",
        severity: "warning",
        path: "skills.entries.missing-tool.enabled",
      }),
    );
  });
});
