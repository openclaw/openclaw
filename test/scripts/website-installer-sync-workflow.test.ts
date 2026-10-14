// Website Installer Sync Workflow tests cover website installer sync workflow script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const { detectInstallSmokeScope } = await import("../../scripts/ci-changed-scope.mjs");

const WORKFLOW_PATH = ".github/workflows/website-installer-sync.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("website installer sync workflow", () => {
  const workflow = readFileSync(WORKFLOW_PATH, "utf8");

  it.each([
    { job: "static", step: "Shell syntax", prefix: "dist/installers" },
    { job: "sync-website", step: "Verify website with synced installers", prefix: "public" },
  ])("parses both shell artifacts in $job before continuing", ({ job, step, prefix }) => {
    const config = parse(workflow) as {
      jobs: Record<string, { steps: { name: string; run?: string }[] }>;
    };
    const run = config.jobs[job]?.steps.find((entry) => entry.name === step)?.run;
    if (!run) {
      throw new Error(`Missing installer syntax step: ${job}/${step}`);
    }
    const root = tempDirs.make("installer-workflow-syntax-");
    const directory = path.join(root, prefix);
    mkdirSync(directory, { recursive: true });
    const installers = ["install.sh", "install-cli.sh"];
    const verify = () =>
      spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", `shellcheck() { exit 0; }\n${run}`], {
        cwd: root,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: root, BASH_ENV: "", ENV: "" },
      });
    for (const installer of installers) {
      writeFileSync(path.join(directory, installer), "#!/bin/bash\ntrue\n");
    }
    const valid = verify();
    expect(valid.status, valid.stderr).toBe(0);
    for (const installer of installers) {
      writeFileSync(path.join(directory, installer), "#!/bin/bash\nif then\n");
      const invalid = verify();
      expect(invalid.status, installer).not.toBe(0);
      expect(invalid.stderr).toContain(installer);
      writeFileSync(path.join(directory, installer), "#!/bin/bash\ntrue\n");
    }
  });

  it("treats all website installer scripts as OpenClaw-owned inputs", () => {
    for (const input of [
      "scripts/install.sh",
      "scripts/install-cli.sh",
      "scripts/install.ps1",
      "scripts/install-policy.sh",
      "scripts/build-installers.mjs",
      "scripts/lib/standalone-installers.mjs",
    ]) {
      expect(workflow).toContain(input);
      expect(detectInstallSmokeScope([input]).runFullInstallSmoke).toBe(true);
    }
  });

  it("verifies installers across Linux privilege and package-manager paths", () => {
    expect(workflow).toContain("linux-docker:");
    expect(workflow).toContain("debian-installer:");
    expect(workflow).toContain("debian:bookworm-slim");
    expect(workflow).toContain("node --version | grep -E '^v24\\.[0-9]+\\.[0-9]+$'");
    expect(workflow).toContain('require("node:sqlite")');
    expect(workflow.match(/timeout --kill-after=30s 20m docker run --rm/g)?.length).toBe(6);
    expect(workflow).toContain("linux-build-tools-failure:");
    expect(workflow).toContain("/tmp/build-tools-stub-triggered");
    expect(workflow).toContain('grep -aFq "Installing build tools failed"');
    expect(workflow).toContain('grep -aFq "Build tools installed"');
    expect(workflow).toContain("linux-non-root:");
    expect(workflow).toContain("sudo -u installer -H bash");
    expect(workflow).toContain('test "$(npm config get prefix)" = "$HOME/.npm-global"');
    expect(workflow).toContain(
      `grep -Fxq 'export PATH="$HOME/.npm-global/bin:$PATH"' "$HOME/.bashrc"`,
    );
    expect(workflow).toContain("fedora-installer:");
    expect(workflow).toContain("user: [root, non-root]");
    expect(workflow.match(/fedora:44/g)?.length).toBe(2);
    expect(workflow).not.toContain("timeout 20m docker run --rm");
    expect(workflow).not.toMatch(/(^|\n)\s+docker run --rm/u);
    expect(workflow).toContain("bash /tmp/install.sh --version latest && openclaw --version");
    expect(workflow).not.toContain("bash /tmp/install.sh --no-prompt --no-onboard");
    expect(workflow).toContain("bash /tmp/install-cli.sh --prefix /tmp/openclaw");
    expect(workflow).toContain("macos-installer:");
    expect(workflow).toContain("runs-on: macos-15");
    expect(workflow).toContain("node-version: 24");
    expect(workflow).toContain('OPENCLAW_NO_ONBOARD: "1"');
    expect(workflow).toContain('OPENCLAW_NO_PROMPT: "1"');
    expect(workflow).toContain(
      "bash dist/installers/install.sh --no-onboard --no-prompt --version latest",
    );
    expect(workflow).toContain("openclaw --version");
    expect(workflow).toContain("windows-installer:");
    expect(workflow).toContain("runs-on: windows-latest");
    expect(workflow).toContain(".\\scripts\\install.ps1 -DryRun");
    expect(workflow).not.toContain("install.cmd dry run");
    expect(workflow).not.toContain(".\\scripts\\install.cmd");
  });

  it("syncs verified scripts to openclaw.ai only after all installer checks pass", () => {
    const syncNeeds = workflow.match(/ {2}sync-website:\n {4}needs:\n((?: {6}- [^\n]+\n)+)/u);
    expect(syncNeeds?.[1]).toBe(
      [
        "static",
        "linux-docker",
        "debian-installer",
        "linux-build-tools-failure",
        "linux-non-root",
        "fedora-installer",
        "macos-installer",
        "windows-installer",
      ]
        .map((job) => `      - ${job}\n`)
        .join(""),
    );
    expect(workflow).toContain("repository: openclaw/openclaw.ai");
    expect(workflow).toContain("OPENCLAW_GH_TOKEN: ${{ secrets.OPENCLAW_GH_TOKEN }}");
    expect(workflow).toContain("OPENCLAW_GH_TOKEN is not configured");
    expect(workflow).toContain("token: ${{ env.OPENCLAW_GH_TOKEN }}");
    expect(workflow).toContain(
      "cp openclaw/dist/installers/install.sh openclaw.ai/public/install.sh",
    );
    expect(workflow).toContain(
      "cp openclaw/dist/installers/install-cli.sh openclaw.ai/public/install-cli.sh",
    );
    expect(workflow).toContain("cp openclaw/scripts/install.ps1 openclaw.ai/public/install.ps1");
    expect(workflow).toContain("rm -f openclaw.ai/public/install.cmd");
    expect(workflow).toContain("bun run build");
    expect(workflow).toContain("git push origin HEAD:main");
  });
});
