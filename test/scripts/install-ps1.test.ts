import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { extractFunctionBody } from "./install-ps1.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";
const SCRIPT_PATH = "scripts/install.ps1";
const source = readFileSync(SCRIPT_PATH, "utf8");
const body = (name: string) => extractFunctionBody(source, name);
// Runtime, cwd and archive identity are exercised by install-ps1.release.test.ts.
it("pipes the SQLite probe through stdin instead of Windows command-line quoting", () => {
  expect(body("Check-Node")).toMatch(
    /Get-Command node -CommandType Application[^]*\$sqliteProbe \| & \$nodePath -/,
  );
});
it("rejects source targets before installing an npm package", () => {
  expect(body("Test-OpenClawSourcePackageInstallSpec")).toMatch(
    /\$normalizedTag -eq "main"[^]*\^github:openclaw\/openclaw/,
  );
  expect(body("Install-OpenClaw")).toMatch(
    /if \(Test-OpenClawSourcePackageInstallSpec[^]*?return \$false[^]*?\$installSpec =/,
  );
});
it("does not read project npmrc when choosing global install freshness args", () => {
  const rawKeyBody = body("Test-NpmConfigRawKey");
  expect(rawKeyBody).not.toContain("Get-Location");
});
it("preserves the min-release-age probe status before raw npmrc detection", () => {
  const npmInstallBody = body("Install-OpenClaw");
  const probeStatusCapture = npmInstallBody.indexOf("$minReleaseAgeStatus = $LASTEXITCODE");
  const rawKeyProbe = npmInstallBody.indexOf("Test-NpmConfigRawKey -Key");
  expect(probeStatusCapture).toBeGreaterThan(-1);
  expect(probeStatusCapture).toBeLessThan(rawKeyProbe);
  expect(npmInstallBody).toContain("} elseif ($minReleaseAgeStatus -ne 0 -or -not $minReleaseAge");
});
const harness = createScriptTestHarness();
const powershell = process.platform === "win32" ? "powershell" : "pwsh";
const powershellArgs = "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass".split(" ");
const runPowerShell = (args: string[]) =>
  spawnSync(powershell, [...powershellArgs, ...args], { encoding: "utf8" });
const probe = spawnSync(powershell, ["-NoLogo", "-NoProfile", "-Command", "exit 0"]);
const runWithPowerShell = probe.status === 0 ? it : it.skip;
runWithPowerShell("runs the piped installer and validates optional Node versions", () => {
  const result = runPowerShell([
    "-File",
    "test/scripts/install-ps1-entrypoint.ps1",
    "-InstallerPath",
    join(process.cwd(), SCRIPT_PATH),
  ]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
runWithPowerShell.each(["file", "streamed"] as const)(
  "preserves handled failure and caller lifetime through the %s installer entrypoint",
  (mode) => {
    const nodePrefix = join(harness.createTempDir("openclaw-install-failure-"), "private-node");
    const scriptPath = join(process.cwd(), SCRIPT_PATH).replaceAll("'", "''");
    const result = runPowerShell(
      mode === "file"
        ? ["-File", SCRIPT_PATH, "-NodePrefix", nodePrefix, "-DryRun"]
        : [
            "-Command",
            `try {
  & ([scriptblock]::Create((Get-Content -LiteralPath '${scriptPath}' -Raw))) -NodePrefix '${nodePrefix.replaceAll("'", "''")}' -DryRun
} catch {
  if ($_.Exception.Message -ne 'OpenClaw installation failed with exit code 2.') { throw }
  Write-Output 'caught canonical failure'
}
Write-Output 'installer caller survived'`,
          ],
    );
    const output = result.stdout.replace(/\r\n/g, "\n");
    expect(result.status, result.stdout + result.stderr).toBe(mode === "file" ? 2 : 0);
    expect(result.stderr).toBe("");
    expect(output).toContain("Error: -NodePrefix and -NodeVersion require -NodeOnly.");
    expect(output.match(/Support: https:\/\/community\.openclaw\.ai\//g)).toHaveLength(1);
    if (mode === "streamed") {
      expect(output).toContain("caught canonical failure\ninstaller caller survived\n");
    }
  },
);
runWithPowerShell(
  "offers support and self-service in Windows installer help without installing",
  () => {
    const result = runPowerShell(["-File", SCRIPT_PATH, "-Help"]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(result.stdout).toContain("Support: https://community.openclaw.ai/");
    expect(result.stdout).toContain("FAQ: https://docs.openclaw.ai/start/faq");
  },
);
runWithPowerShell.each(["valid", "missing-head", "broken-gitfile", "subdirectory"])(
  "preserves real Git checkout boundaries before package setup: %s",
  (scenario) => {
    const result = runPowerShell([
      "-File",
      "test/scripts/install-git-worktree.ps1",
      "-InstallerPath",
      join(process.cwd(), SCRIPT_PATH),
      "-FixtureRoot",
      join(harness.createTempDir("openclaw-install-worktree-"), "fixture"),
      "-Scenario",
      scenario,
    ]);
    expect(result.status, result.stdout + result.stderr).toBe(0);
  },
);
const runHandoffFixture = (scenario: string) => {
  const result = runPowerShell([
    "-File",
    "test/scripts/install-ps1-handoff.ps1",
    "-InstallerPath",
    join(process.cwd(), SCRIPT_PATH),
    "-FixtureRoot",
    harness.createTempDir("openclaw-install-handoff-"),
    "-Scenario",
    scenario,
  ]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
};
runWithPowerShell("prints a manual setup command after batch process creation fails", () => {
  runHandoffFixture("failure");
});
const runWithWindowsPowerShell = process.platform === "win32" ? runWithPowerShell : it.skip;
runWithWindowsPowerShell(
  "executes a batch shim in a literal special-character path and preserves its exit status",
  () => {
    runHandoffFixture("launch");
  },
);
runWithPowerShell("restores a conflicted pull before continuing a Git install", () => {
  const result = runPowerShell([
    "-File",
    "test/scripts/install-git-pull.ps1",
    "-InstallerPath",
    join(process.cwd(), SCRIPT_PATH),
    "-FixtureRoot",
    join(harness.createTempDir("openclaw-install-pull-"), "fixture"),
  ]);
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
