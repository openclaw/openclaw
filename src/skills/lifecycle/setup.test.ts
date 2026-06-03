import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { runSkillSetupHook } from "./setup.js";

const tempDirs = createTrackedTempDirs();

function writeSkillMd(dir: string, metadata?: Record<string, unknown>, filename = "SKILL.md") {
  const lines = ["---", "name: Test Skill", "description: A test skill."];
  if (metadata) {
    lines.push(`metadata: '${JSON.stringify(metadata)}'`);
  }
  lines.push("---", "", "# Test");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), lines.join("\n"), "utf8");
}

function writeScript(dir: string, relPath: string, content: string, mode = 0o755) {
  const scriptPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
  fs.writeFileSync(scriptPath, content, "utf8");
  fs.chmodSync(scriptPath, mode);
}

function setupMetadata(script: string, extra: Record<string, unknown> = {}) {
  return { openclaw: { setup: { script }, ...extra } };
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("runSkillSetupHook", () => {
  it.each([
    ["missing SKILL.md", undefined, undefined],
    ["SKILL.md without setup", {}, "SKILL.md"],
  ])("returns ok for %s", async (_name, metadata, filename) => {
    const dir = await tempDirs.make("openclaw-setup-noop-");
    if (metadata !== undefined) {
      writeSkillMd(dir, metadata, filename);
    }

    await expect(runSkillSetupHook({ targetDir: dir, mode: "install" })).resolves.toEqual({
      ok: true,
    });
  });

  it("runs setup scripts with hook context", async () => {
    const dir = await tempDirs.make("openclaw-setup-run-");
    writeSkillMd(dir, setupMetadata("scripts/setup.sh"));
    writeScript(
      dir,
      "scripts/setup.sh",
      [
        "#!/bin/sh",
        `test "$SKILL_DIR" = "${path.resolve(dir)}" || exit 1`,
        'test "$OPENCLAW_HOOK_KIND" = "update" || exit 2',
      ].join("\n"),
    );

    await expect(runSkillSetupHook({ targetDir: dir, mode: "update" })).resolves.toEqual({
      ok: true,
    });
  });

  it.each([
    ["path traversal", "../outside.sh", undefined, "path traversal"],
    ["missing script", "scripts/missing.sh", undefined, "not found"],
    ["non-zero exit", "scripts/fail.sh", "#!/bin/sh\nexit 2\n", "exited with code 2"],
  ])("fails for %s", async (_name, script, scriptContent, expectedError) => {
    const dir = await tempDirs.make("openclaw-setup-fail-");
    writeSkillMd(dir, setupMetadata(script));
    if (scriptContent) {
      writeScript(dir, script, scriptContent);
    }

    const result = await runSkillSetupHook({ targetDir: dir, mode: "install" });
    expect(result).toMatchObject({ ok: false, failureKind: "setup-failed" });
    if (!result.ok) {
      expect(result.error).toContain(expectedError);
    }
  });
});
