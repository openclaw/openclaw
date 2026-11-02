import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const actionPath = resolve(".github/actions/prepare-testbox-shell");
const action = parse(readFileSync(join(actionPath, "action.yml"), "utf8"));
const prepare = action.runs.steps.find(
  (step: { name: string }) => step.name === "Isolate Testbox sync workspace",
).run as string;
const legacy = [
  'if [ -n "${SSH_CONNECTION:-}${SSH_CLIENT:-}${SSH_TTY:-}" ]; then',
  "    [ -r /run/blacksmith/job.env ] && . /run/blacksmith/job.env",
  '    [ -d "${GITHUB_WORKSPACE:-}" ] && cd "${GITHUB_WORKSPACE}"',
  "fi",
].join("\n");
const unrelated = "# unrelated image setup\nexport TESTBOX_FIXTURE_IMAGE=untouched\n";
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

function fixture(profileText = unrelated + legacy + "\n", repair = true) {
  const root = tempDirs.make("openclaw-testbox-cwd-");
  const write = (name: string, text: string, executable = false) => {
    const file = join(root, name);
    writeFileSync(file, text, executable ? { mode: 0o755 } : undefined);
    return file;
  };
  const workspace = join(root, "hydrated main");
  const runnerTemp = join(root, "runner temp");
  const bin = join(root, "bin");
  for (const dir of [workspace, runnerTemp, bin]) {
    mkdirSync(dir);
  }
  const profile = write("blacksmith.sh", profileText);
  const runtimeProfile = join(root, "runtime-profile.sh");
  const jobEnv = write(
    "job env",
    "export GITHUB_WORKSPACE=" + quote(workspace) + "\nexport TESTBOX_FIXTURE_ENV=preserved\n",
  );
  const state = write("working_directory", workspace + "\n");
  write("bin/sudo", repair ? '#!/bin/sh\nexec "$@"\n' : "#!/bin/sh\nexit 0\n", true);
  // Keep the vendor bytes intact for the adaptation, but never execute a host
  // job.env reference. BASH_ENV loads the rewritten fixture during Bash startup.
  write(
    "bin/bash",
    `#!/usr/bin/env python3
import os, pathlib, shlex, sys
profile = pathlib.Path(os.environ["TESTBOX_FIXTURE_PROFILE"])
runtime = pathlib.Path(os.environ["TESTBOX_FIXTURE_RUNTIME_PROFILE"])
runtime.write_text(profile.read_text().replace("/run/blacksmith/job.env", shlex.quote(os.environ["TESTBOX_FIXTURE_JOB_ENV"])))
os.environ["BASH_ENV"] = str(runtime)
os.execv("/bin/bash", ["bash", "--noprofile", "--norc", *sys.argv[1:]])
`,
    true,
  );
  const env = {
    PATH: bin + ":" + process.env.PATH,
    HOME: root,
    GITHUB_WORKSPACE: workspace,
    GITHUB_ACTION_PATH: actionPath,
    RUNNER_TEMP: runnerTemp,
    TESTBOX_FIXTURE_PROFILE: profile,
    TESTBOX_FIXTURE_RUNTIME_PROFILE: runtimeProfile,
    TESTBOX_FIXTURE_JOB_ENV: jobEnv,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Testbox fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Testbox fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
  git(workspace, "init", "-q", "--initial-branch=main");
  git(workspace, "remote", "add", "origin", "https://example.invalid/testbox.git");
  writeFileSync(join(workspace, "marker"), "hydrated\n");
  git(workspace, "add", ".");
  git(workspace, "commit", "-qm", "hydrated base");
  const script = prepare
    .replace("/tmp/.testbox/working_directory", quote(state))
    .replace("/etc/profile.d/blacksmith.sh", quote(profile));
  const run = () =>
    spawnSync("/bin/bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", script], {
      cwd: workspace,
      env,
      encoding: "utf8",
    });
  const command = (cwd: string, args: string[]) =>
    spawnSync(join(bin, "bash"), args, {
      cwd,
      env: { ...env, SSH_CONNECTION: "127.0.0.1 1 127.0.0.1 22" },
      encoding: "utf8",
    });
  return { workspace, profile, state, git, run, command };
}

it.each([
  { name: "legacy", profile: unrelated + legacy + "\n" },
  { name: "upstream", profile: unrelated },
])(
  "preserves selected checkout, patch, and subdirectory with the $name profile",
  ({ name, profile }) => {
    const f = fixture(profile);
    const prepared = f.run();
    expect(prepared.status, prepared.stderr).toBe(0);
    const syncRoot = readFileSync(f.state, "utf8").trim();
    expect(syncRoot).not.toBe(f.workspace);
    expect(realpathSync(join(syncRoot, ".git/crabbox-artifact-root"))).toBe(f.workspace);
    // Simulate native task source sync after the action's clone.
    writeFileSync(join(syncRoot, "marker"), "task base\n");
    f.git(syncRoot, "commit", "-qam", "task base");
    const taskHead = f.git(syncRoot, "rev-parse", "HEAD");
    writeFileSync(join(syncRoot, "marker"), "task patch\n");
    writeFileSync(join(syncRoot, "task-untracked"), "synchronized\n");
    const result = f.command(syncRoot, [
      "-lc",
      'pwd -P; git rev-parse HEAD; cat marker task-untracked; printf "%s\\n" "$TESTBOX_FIXTURE_ENV"',
    ]);
    const exported = name === "legacy" ? "preserved" : "";
    expect(result, result.stderr).toMatchObject({
      status: 0,
      stdout: `${syncRoot}\n${taskHead}\ntask patch\nsynchronized\n${exported}\n`,
    });
    const subdir = join(syncRoot, "task subdir");
    mkdirSync(subdir);
    for (const cwd of [subdir, f.workspace]) {
      const selected = f.command(cwd, ["-lc", "bash -lc 'pwd -P'"]);
      expect(selected.status, selected.stderr).toBe(0);
      expect(selected.stdout.trim()).toBe(cwd);
    }
    expect(readFileSync(join(f.workspace, "marker"), "utf8")).toBe("hydrated\n");
    const repaired = readFileSync(f.profile, "utf8");
    expect(repaired).toContain(unrelated);
    execFileSync("python3", ["-I", "-S", join(actionPath, "preserve-command-cwd.py"), f.profile]);
    expect(readFileSync(f.profile, "utf8")).toBe(repaired);
    const interactive = f.command(subdir, ["-ic", '. "$BASH_ENV"; pwd -P']);
    expect(interactive.status, interactive.stderr).toBe(0);
    expect(interactive.stdout.trim()).toBe(name === "legacy" ? f.workspace : subdir);
  },
);

it.each([
  { name: "unadapted image", profile: unrelated + legacy + "\n", repair: false },
  { name: "unknown startup hook", profile: unrelated + 'cd "$GITHUB_WORKSPACE"\n', repair: true },
])("refuses readiness for an $name even when HEADs match", ({ profile, repair }) => {
  const f = fixture(profile, repair);
  const result = f.run();
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("Testbox login shell changed checkout: expected");
  expect(readFileSync(f.state, "utf8")).toBe(f.workspace + "\n");
  expect(readFileSync(f.profile, "utf8")).toBe(profile);
});
