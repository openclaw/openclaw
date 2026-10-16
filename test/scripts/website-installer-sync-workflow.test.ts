// Website Installer Sync Workflow tests cover website installer sync workflow script behavior.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { compileFunction } from "node:vm";
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

  it.each([
    { name: "installed", packageStatus: 0, installStatus: 0, expectedStatus: 0, installs: false },
    { name: "missing", packageStatus: 1, installStatus: 0, expectedStatus: 0, installs: true },
    {
      name: "install failure",
      packageStatus: 1,
      installStatus: 42,
      expectedStatus: 42,
      installs: true,
    },
  ])("prepares $name Fedora prerequisites before creating the installer user", (scenario) => {
    const config = parse(workflow) as {
      jobs: Record<string, { steps: { name: string; run?: string }[] }>;
    };
    const run = config.jobs["fedora-installer"]?.steps.find(
      (step) => step.name === "install.sh on Fedora",
    )?.run;
    if (!run) {
      throw new Error("Missing Fedora installer step");
    }
    const root = tempDirs.make("fedora-workflow-prerequisites-");
    const result = spawnSync(
      "/bin/bash",
      [
        "-e",
        "-o",
        "pipefail",
        "-c",
        `timeout() { shift 2; "$@"; }
docker() { /bin/bash -se; }
rpm() { [[ "$*" == "-q sudo shadow-utils" ]] || return 64; return ${scenario.packageStatus}; }
dnf() { [[ "$*" == "install -y -q sudo shadow-utils" ]] || return 64; printf 'install\\n'; return ${scenario.installStatus}; }
useradd() { printf 'create-user\\n'; exit 0; }
export -f timeout docker rpm dnf useradd
${run}`,
      ],
      {
        cwd: root,
        encoding: "utf8",
        env: { PATH: root, HOME: root, BASH_ENV: "", ENV: "", INSTALL_USER: "non-root" },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(scenario.expectedStatus);
    expect(result.stdout.trim().split(/\r?\n/u)).toEqual([
      ...(scenario.installs ? ["install"] : []),
      ...(scenario.expectedStatus === 0 ? ["create-user"] : []),
    ]);
  });

  it.each(["root", "non-root"])(
    "retains DNF diagnostics after a killed %s Fedora container",
    (user) => {
      const config = parse(workflow) as {
        jobs: Record<string, { steps: { name: string; if?: string; run?: string }[] }>;
      };
      const steps = config.jobs["fedora-installer"]?.steps ?? [];
      const run = steps.find((step) => step.name === "install.sh on Fedora")?.run;
      if (!run) {
        throw new Error("Missing Fedora installer step");
      }
      const root = tempDirs.make("fedora-workflow-diagnostics-");
      const env = {
        PATH: process.env.PATH,
        HOME: root,
        RUNNER_TEMP: root,
        BASH_ENV: "",
        ENV: "",
        INSTALL_USER: user,
      };
      const install = spawnSync(
        "/bin/bash",
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
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
${run}`,
        ],
        { cwd: root, encoding: "utf8", env },
      );
      expect(install.status, install.stderr).toBe(137);
      const diagnostics = spawnSync(
        "/bin/bash",
        [
          "-e",
          "-o",
          "pipefail",
          "-c",
          `sudo() { "$@"; }\n${steps
            .filter((step) => step.if === "failure()")
            .map((step) => step.run ?? "")
            .join("\n")}`,
        ],
        { cwd: root, encoding: "utf8", env },
      );
      expect(diagnostics.status, diagnostics.stderr).toBe(0);
      expect(diagnostics.stdout).toContain("librepo: fixture mirror connection stalled");
    },
  );

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

describe("installer platform admission", () => {
  const workflow = parse(readFileSync(WORKFLOW_PATH, "utf8")) as {
    jobs: Record<
      string,
      {
        if?: string;
        steps: { id?: string; name?: string; if?: string; with?: { script?: string } }[];
      }
    >;
  };
  const script = workflow.jobs.scope?.steps.find((step) => step.id === "scope")?.with?.script;
  if (!script) {
    throw new Error("Missing installer platform selection");
  }
  const execute = compileFunction(
    `return (async () => {
${script}
})();`,
    ["context", "core", "exec", "process"],
  ) as (...args: unknown[]) => Promise<void>;
  const unixJobs = [
    "linux-docker",
    "debian-installer",
    "linux-build-tools-failure",
    "linux-non-root",
    "fedora-installer",
    "macos-installer",
  ];

  async function select(
    options: {
      event?: string;
      cwd?: string;
      checkout?: string;
      diffExitCodes?: number[];
    } = {},
  ) {
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
          if (exitCode !== undefined) {
            return { exitCode };
          }
          const result = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
          return { exitCode: result.status ?? 128 };
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
      [...unixJobs, "windows-installer", "static"].map((job) => [
        job,
        evaluate(workflow.jobs[job]!.if!),
      ]),
    );
    const staticSteps = Object.fromEntries(
      workflow.jobs
        .static!.steps.filter((step) => step.if)
        .map((step) => [step.name, evaluate(step.if!)]),
    );
    return { outputs, jobs, staticSteps, diffCalls, evaluate };
  }

  it.each([
    { file: "scripts/install.ps1", unix: false, windows: true },
    ...[
      "scripts/install.sh",
      "scripts/install-cli.sh",
      "scripts/install-policy.sh",
      "scripts/build-installers.mjs",
      "scripts/lib/standalone-installers.mjs",
    ].map((file) => ({ file, unix: true, windows: false })),
    { file: ".github/workflows/website-installer-sync.yml", unix: true, windows: true },
    { file: "scripts/install.ps1", moveTo: "retired.ps1", unix: false, windows: true },
    { file: "retired.ps1", moveTo: "scripts/install.ps1", unix: false, windows: true },
  ])("routes the tested event tree for $file (move: $moveTo)", async (scenario) => {
    const cwd = tempDirs.make("installer-platform-scope-");
    const git = (...args: string[]) => {
      const result = spawnSync(
        "git",
        ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args],
        {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.com",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.com",
          },
        },
      );
      expect(result.status, result.stderr).toBe(0);
    };
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
    expect(result.evaluate(workflow.jobs["windows-installer"]!.if!, true)).toBe(false);
  });

  it.each(["push", "workflow_dispatch"])("keeps full %s validation", async (event) => {
    const result = await select({ event });
    expect(result.diffCalls).toBe(0);
    expect(result.outputs).toEqual({ unix: "true", windows: "true" });
    expect(Object.values(result.jobs).every(Boolean)).toBe(true);
    expect(Object.values(result.staticSteps).every(Boolean)).toBe(true);
  });

  it.each([
    { checkout: "failure", diffExitCodes: [] },
    { diffExitCodes: [128] },
    { diffExitCodes: [0, 128] },
  ])("retains every platform when exact scope is unavailable: %j", async (options) => {
    const result = await select(options);
    expect(result.outputs).toEqual({ unix: "true", windows: "true" });
    expect(Object.values(result.jobs).every(Boolean)).toBe(true);
  });
});
