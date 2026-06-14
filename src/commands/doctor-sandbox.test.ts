import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveSandboxScript } from "./doctor-sandbox.js";

describe("resolveSandboxScript", () => {
  const created: string[] = [];

  afterEach(() => {
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    created.push(dir);
    // Resolve macOS /var → /private/var so expectations match realpath output.
    return fs.realpathSync(dir);
  }

  it("follows a symlinked launcher to find scripts/ in the real repo", () => {
    // Repo checkout that actually contains scripts/sandbox-setup.sh ...
    const repo = mkTmp("ocsbx-repo-");
    const scriptRel = path.join("scripts", "sandbox-setup.sh");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, scriptRel), "#!/bin/sh\n");
    const entry = path.join(repo, "openclaw.mjs");
    fs.writeFileSync(entry, "");

    // ... reached only via a symlinked launcher in an unrelated bin dir (the npm/pnpm global case).
    const binDir = mkTmp("ocsbx-bin-");
    const launcher = path.join(binDir, "openclaw");
    fs.symlinkSync(entry, launcher);

    const result = resolveSandboxScript(scriptRel, { argv1: launcher, cwd: binDir });

    // Without following the symlink this returns null (the old bug); with realpath it finds the repo.
    expect(result).not.toBeNull();
    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
    expect(result?.cwd).toBe(repo);
  });

  it("still resolves a script relative to a non-symlinked launcher dir", () => {
    const repo = mkTmp("ocsbx-direct-");
    const scriptRel = path.join("scripts", "sandbox-setup.sh");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, scriptRel), "#!/bin/sh\n");
    const entry = path.join(repo, "openclaw.mjs");
    fs.writeFileSync(entry, "");

    const result = resolveSandboxScript(scriptRel, { argv1: entry, cwd: os.tmpdir() });

    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
  });

  it("returns null when the script is unreachable from cwd or the launcher", () => {
    const binDir = mkTmp("ocsbx-none-");
    const launcher = path.join(binDir, "openclaw");
    fs.writeFileSync(launcher, "");

    expect(
      resolveSandboxScript(path.join("scripts", "sandbox-setup.sh"), {
        argv1: launcher,
        cwd: binDir,
      }),
    ).toBeNull();
  });

  it("resolves via cwd when no launcher (argv1) is available", () => {
    const repo = mkTmp("ocsbx-cwd-");
    const scriptRel = path.join("scripts", "sandbox-setup.sh");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, scriptRel), "#!/bin/sh\n");

    const result = resolveSandboxScript(scriptRel, { argv1: undefined, cwd: repo });

    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
    expect(result?.cwd).toBe(repo);
  });

  it("tolerates a non-existent launcher path (realpath throws) and still uses cwd", () => {
    const repo = mkTmp("ocsbx-missing-argv1-");
    const scriptRel = path.join("scripts", "sandbox-setup.sh");
    fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(repo, scriptRel), "#!/bin/sh\n");

    const result = resolveSandboxScript(scriptRel, {
      argv1: "/nonexistent-ocsbx/bin/openclaw",
      cwd: repo,
    });

    expect(result?.scriptPath).toBe(path.join(repo, scriptRel));
    expect(result?.cwd).toBe(repo);
  });
});
