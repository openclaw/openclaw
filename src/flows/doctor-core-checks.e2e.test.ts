// Doctor core check E2E tests cover doctor checks in filesystem-backed scenarios.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import type { HealthCheck } from "./health-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

function getCheck(id: string): HealthCheck {
  const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`Missing health check ${id}`);
  }
  return check;
}

describe("doctor core skills readiness smoke", () => {
  let tmp: string | undefined;

  afterEach(async () => {
    if (tmp !== undefined) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = undefined;
    }
  });

  it("detects and repairs a real unavailable workspace skill", async () => {
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
    const check = getCheck("core/doctor/skills-readiness");

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg,
      cwd: tmp,
    });
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/skills-readiness",
        severity: "warning",
        path: "skills.entries.missing-tool.enabled",
      }),
    );
    await expect(
      check.detect(
        {
          mode: "fix",
          runtime,
          cfg,
          cwd: tmp,
        },
        { paths: ["skills.entries.other-tool.enabled"] },
      ),
    ).resolves.toEqual([]);
    await expect(
      check.detect(
        {
          mode: "fix",
          runtime,
          cfg,
          cwd: tmp,
        },
        { paths: ["skills.entries.missing-tool.enabled"] },
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        path: "skills.entries.missing-tool.enabled",
      }),
    );

    const repaired = await check.repair?.(
      {
        mode: "fix",
        runtime,
        cfg,
        cwd: tmp,
      },
      findings,
    );
    expect(repaired?.config?.skills?.entries?.["missing-tool"]).toEqual({ enabled: false });
    expect(repaired?.changes).toContain("Disabled unavailable skill missing-tool.");
    expect(repaired?.effects).toContainEqual(
      expect.objectContaining({
        kind: "config",
        action: "disable-skill",
        target: "skills.entries.missing-tool.enabled",
      }),
    );
  });

  it("detects a real workspace skill shadowing a configured lower-precedence skill", async () => {
    tmp = await fs.mkdtemp(join(tmpdir(), "openclaw-health-skills-shadow-"));
    const extraDir = join(tmp, "extra-skills");
    const extraSkillDir = join(extraDir, "same-name");
    const workspaceSkillDir = join(tmp, "skills", "same-name");
    await fs.mkdir(extraSkillDir, { recursive: true });
    await fs.mkdir(workspaceSkillDir, { recursive: true });
    await fs.writeFile(
      join(extraSkillDir, "SKILL.md"),
      `---
name: same-name
description: Extra version
---

# Extra version
`,
      "utf-8",
    );
    await fs.writeFile(
      join(workspaceSkillDir, "SKILL.md"),
      `---
name: same-name
description: Workspace version
---

# Workspace version
`,
      "utf-8",
    );
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: tmp,
        },
      },
      skills: {
        load: {
          extraDirs: [extraDir],
        },
      },
    };
    const check = getCheck("core/doctor/skills-readiness");

    const findings = await check.detect({
      mode: "lint",
      runtime,
      cfg,
      cwd: tmp,
    });

    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/skills-readiness",
        severity: "warning",
        path: "skills.entries.same-name.enabled",
        requirement: "skill-source-shadowing",
      }),
    );
  });
});
