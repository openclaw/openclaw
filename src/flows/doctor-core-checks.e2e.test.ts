import { promises as fs } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";

const runtime = { log() {}, error() {}, exit() {} };

const dirs = useAutoCleanupTempDirTracker(afterEach);

it("detects and repairs a real unavailable workspace skill", async () => {
  const tmp = dirs.make("openclaw-health-skills-");
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
    agents: { defaults: { workspace: tmp, skills: ["missing-tool"] } },
  };
  const check = CORE_HEALTH_CHECKS.find((entry) => entry.id === "core/doctor/skills-readiness")!;
  const ctx = { mode: "fix" as const, runtime, cfg, cwd: tmp };

  const findings = await check.detect({ ...ctx, mode: "lint" });
  const finding = expect.objectContaining({
    checkId: "core/doctor/skills-readiness",
    severity: "warning",
    path: "skills.entries.missing-tool.enabled",
  });
  expect(findings).toContainEqual(finding);
  await expect(
    check.detect(ctx, { paths: ["skills.entries.other-tool.enabled"] }),
  ).resolves.toEqual([]);
  await expect(
    check.detect(ctx, { paths: ["skills.entries.missing-tool.enabled"] }),
  ).resolves.toContainEqual(finding);

  const repaired = await check.repair?.(ctx, findings);
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
