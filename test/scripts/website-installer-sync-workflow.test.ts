import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileFunction } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { detectInstallSmokeScope } from "../../scripts/ci-changed-scope.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflow = readFileSync(".github/workflows/website-installer-sync.yml", "utf8");
type Step = { id?: string; name?: string; if?: string; run?: string; with?: { script?: string } };
const config = parse(workflow) as {
  jobs: Record<
    string,
    { if?: string; needs?: string[]; steps: Step[]; strategy?: { matrix?: { debian?: string[] } } }
  >;
};
const unixJobs = [
  "linux-docker",
  "debian-installer",
  "linux-build-tools-failure",
  "linux-non-root",
  "fedora-installer",
  "macos-installer",
];
const scopedJobs = ["static", ...unixJobs, "windows-installer"];
const unixInputs = [
  "scripts/install.sh",
  "scripts/install-cli.sh",
  "scripts/install-policy.sh",
  "scripts/build-installers.mjs",
  "scripts/lib/standalone-installers.mjs",
];
function contains(...fragments: string[]) {
  for (const fragment of fragments) {
    expect(workflow).toContain(fragment);
  }
}
function stepRun(job: string, name: string) {
  const run = config.jobs[job]?.steps.find((step) => step.name === name)?.run;
  if (!run) {
    throw new Error(`Missing installer step: ${job}/${name}`);
  }
  return run;
}
function shell(root: string, script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-e", "-o", "pipefail", "-c", script], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: root, BASH_ENV: "", ENV: "", ...env },
  });
}

describe("website installer sync workflow", () => {
  it.each([
    { job: "static", step: "Shell syntax", prefix: "dist/installers" },
    { job: "sync-website", step: "Verify website with synced installers", prefix: "public" },
  ])("parses both shell artifacts in $job before continuing", ({ job, step, prefix }) => {
    const run = stepRun(job, step);
    const root = tempDirs.make("installer-workflow-syntax-");
    const directory = path.join(root, prefix);
    mkdirSync(directory, { recursive: true });
    const installers = ["install.sh", "install-cli.sh"];
    const verify = () => shell(root, `shellcheck() { exit 0; }\n${run}`);
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

  it.each([
    ["installed", 0, 0, ["create-user"]],
    ["missing", 1, 0, ["install", "create-user"]],
    ["install failure", 1, 42, ["install"]],
  ] as const)("prepares %s Fedora prerequisites", (_, rpmCode, dnfCode, output) => {
    const root = tempDirs.make("fedora-workflow-prerequisites-");
    const result = shell(
      root,
      `timeout() { shift 2; "$@"; }
docker() { /bin/bash -se; }
rpm() { [[ "$*" == "-q sudo shadow-utils" ]] || return 64; return ${rpmCode}; }
dnf() { [[ "$*" == "install -y -q sudo shadow-utils" ]] || return 64; printf 'install\\n'; return ${dnfCode}; }
useradd() { printf 'create-user\\n'; exit 0; }
export -f timeout docker rpm dnf useradd
${stepRun("fedora-installer", "install.sh on Fedora")}`,
      { PATH: root, INSTALL_USER: "non-root" },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(dnfCode);
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual(output);
  });

  it.each(["root", "non-root"])("retains DNF diagnostics for killed %s containers", (user) => {
    const root = tempDirs.make("fedora-workflow-diagnostics-");
    const env = { RUNNER_TEMP: root, INSTALL_USER: user };
    expect(config.jobs["fedora-installer"]?.steps).toContainEqual(
      expect.objectContaining({ name: "Fedora package-manager diagnostics", if: "failure()" }),
    );
    const install = shell(
      root,
      `timeout() { shift 2; "$@"; }
docker() {
  for argument in "$@"; do
    if [[ "$argument" == *:/var/log ]]; then
      directory="\${argument%:/var/log}"
      mkdir -p "$directory"
      printf 'librepo: fixture mirror connection stalled\\n' > "$directory/dnf5.log"
    fi
  done
  return 137
}
${stepRun("fedora-installer", "install.sh on Fedora")}`,
      env,
    );
    expect(install.status, install.stderr).toBe(137);
    const diagnostics = shell(
      root,
      `sudo() { "$@"; }\n${stepRun("fedora-installer", "Fedora package-manager diagnostics")}`,
      env,
    );
    expect(diagnostics.status, diagnostics.stderr).toBe(0);
    expect(diagnostics.stdout).toContain("librepo: fixture mirror connection stalled");
  });

  it("verifies installers across Linux privilege and package-manager paths", () => {
    expect(Object.keys(config.jobs)).toEqual(expect.arrayContaining(unixJobs));
    for (const job of [
      "linux-docker",
      "debian-installer",
      "linux-build-tools-failure",
      "linux-non-root",
    ]) {
      expect(config.jobs[job]?.strategy?.matrix?.debian, job).toEqual(["bookworm", "trixie"]);
      expect(
        config.jobs[job]?.steps.some((step) => step.run?.includes("${{ matrix.debian }}")),
      ).toBe(true);
    }
    contains(
      "debian:${{ matrix.debian }}-slim",
      "node --version | grep -E '^v24\\.[0-9]+\\.[0-9]+$'",
      'require("node:sqlite")',
      "/tmp/build-tools-stub-triggered",
      'grep -aFq "Installing build tools failed"',
      'grep -aFq "Build tools installed"',
      "sudo -u installer -H bash",
      'test "$(npm config get prefix)" = "$HOME/.npm-global"',
      `grep -Fxq 'export PATH="$HOME/.npm-global/bin:$PATH"' "$HOME/.bashrc"`,
      "user: [root, non-root]",
      "bash /tmp/install.sh --version latest && openclaw --version",
      "bash /tmp/install-cli.sh --prefix /tmp/openclaw",
      "runs-on: macos-15",
      "node-version: 24",
      'OPENCLAW_NO_ONBOARD: "1"',
      'OPENCLAW_NO_PROMPT: "1"',
      "bash dist/installers/install.sh --no-onboard --no-prompt --version latest",
      "openclaw --version",
      "windows-installer:",
      "runs-on: windows-latest",
      ".\\scripts\\install.ps1 -DryRun",
    );
    expect(workflow.match(/timeout --kill-after=30s 20m docker run --rm/g)?.length).toBe(6);
    expect(workflow.match(/fedora:44/g)?.length).toBe(2);
    expect(workflow).not.toMatch(/(^|\n)\s+docker run --rm/u);
    for (const absent of [
      "timeout 20m docker run --rm",
      "bash /tmp/install.sh --no-prompt --no-onboard",
      "install.cmd dry run",
      ".\\scripts\\install.cmd",
    ]) {
      expect(workflow).not.toContain(absent);
    }
  });

  it("syncs verified scripts to openclaw.ai only after all installer checks pass", () => {
    expect(config.jobs["sync-website"]?.needs).toEqual(scopedJobs);
    contains(
      "repository: openclaw/openclaw.ai",
      "OPENCLAW_GH_TOKEN: ${{ secrets.OPENCLAW_GH_TOKEN }}",
      "OPENCLAW_GH_TOKEN is not configured",
      "token: ${{ env.OPENCLAW_GH_TOKEN }}",
      "cp openclaw/dist/installers/install.sh openclaw.ai/public/install.sh",
      "cp openclaw/dist/installers/install-cli.sh openclaw.ai/public/install-cli.sh",
      "cp openclaw/scripts/install.ps1 openclaw.ai/public/install.ps1",
      "rm -f openclaw.ai/public/install.cmd",
      "bun run build",
      "git push origin HEAD:main",
    );
  });
});

describe("installer platform admission", () => {
  const script = config.jobs.scope?.steps.find((step) => step.id === "scope")?.with?.script;
  if (!script) {
    throw new Error("Missing installer platform selection");
  }
  const execute = compileFunction(`return (async () => {\n${script}\n})();`, [
    "context",
    "core",
    "exec",
    "process",
  ]) as (...args: unknown[]) => Promise<void>;

  type Selection = { event?: string; cwd?: string; checkout?: string; diffExitCodes?: number[] };
  async function select(options: Selection = {}) {
    const outputs: Record<string, string> = {};
    let diffCalls = 0;
    await execute(
      { eventName: options.event ?? "pull_request" },
      {
        setOutput: (key: string, value: string) => {
          outputs[key] = value;
        },
        info() {},
        warning() {},
      },
      {
        getExecOutput: async (command: string, args: string[]) => {
          const exitCode = options.diffExitCodes?.[diffCalls++];
          return {
            exitCode: exitCode ?? spawnSync(command, args, { cwd: options.cwd }).status ?? 128,
          };
        },
      },
      { env: { INSTALLER_CHECKOUT_OUTCOME: options.checkout ?? "success" } },
    );
    const needs = { scope: { result: "success", outputs } };
    const evaluate = (guard: string, cancelled = false) =>
      compileFunction(`return (${guard.replace(/^\$\{\{\s*|\s*\}\}$/gu, "")});`, [
        "needs",
        "cancelled",
      ])(needs, () => cancelled) as boolean;
    const jobs = Object.fromEntries(
      scopedJobs.map((job) => [job, evaluate(config.jobs[job]!.if!)]),
    );
    const staticSteps = Object.fromEntries(
      config.jobs
        .static!.steps.filter((step) => step.if)
        .map((step) => [step.name, evaluate(step.if!)]),
    );
    return { outputs, jobs, staticSteps, diffCalls, evaluate };
  }

  it.each([
    { file: "scripts/install.ps1", unix: false, windows: true },
    ...unixInputs.map((file) => ({ file, unix: true, windows: false })),
    { file: ".github/workflows/website-installer-sync.yml", unix: true, windows: true },
    { file: "scripts/install.ps1", moveTo: "retired.ps1", unix: false, windows: true },
    { file: "retired.ps1", moveTo: "scripts/install.ps1", unix: false, windows: true },
  ])("routes the tested event tree for $file (move: $moveTo)", async (scenario) => {
    if (scenario.file.startsWith("scripts/")) {
      expect(workflow).toContain(scenario.file);
      expect(detectInstallSmokeScope([scenario.file]).runFullInstallSmoke).toBe(true);
    }
    const cwd = tempDirs.make("installer-platform-scope-");
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
        {
          cwd,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          },
        },
      );
    const original = path.join(cwd, scenario.file);
    mkdirSync(path.dirname(original), { recursive: true });
    writeFileSync(original, "base\n");
    git("init", "-q");
    git("add", ".");
    git("commit", "-qm", "base");
    if ("moveTo" in scenario && scenario.moveTo) {
      mkdirSync(path.dirname(path.join(cwd, scenario.moveTo)), { recursive: true });
      git("mv", scenario.file, scenario.moveTo);
    } else {
      writeFileSync(original, "changed\n");
    }
    git("add", ".");
    git("commit", "-qm", "event tree");
    const result = await select({ cwd });
    expect(result.outputs).toEqual({
      unix: String(scenario.unix),
      windows: String(scenario.windows),
    });
    for (const job of unixJobs) {
      expect(result.jobs[job], job).toBe(scenario.unix);
    }
    expect(result.jobs["windows-installer"]).toBe(scenario.windows);
    expect(result.staticSteps["Shell syntax"]).toBe(scenario.unix);
    expect(result.staticSteps["PowerShell syntax"]).toBe(scenario.windows);
    expect(result.jobs.static).toBe(true);
    expect(result.evaluate(config.jobs["windows-installer"]!.if!, true)).toBe(false);
  });

  it.each([
    { event: "push" },
    { event: "workflow_dispatch" },
    { checkout: "failure", diffExitCodes: [] },
    { diffExitCodes: [128] },
    { diffExitCodes: [0, 128] },
  ])("keeps full validation for unrestricted or unavailable scope: %j", async (options) => {
    const result = await select(options);
    if ("event" in options) {
      expect(result.diffCalls).toBe(0);
    }
    expect(result.outputs).toEqual({ unix: "true", windows: "true" });
    expect(Object.values(result.jobs).every(Boolean)).toBe(true);
    expect(Object.values(result.staticSteps).every(Boolean)).toBe(true);
  });
});
