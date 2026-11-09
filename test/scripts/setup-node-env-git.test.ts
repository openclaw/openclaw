import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const helper = ".github/actions/setup-node-env/ensure-git.sh";
const action = parse(readFileSync(".github/actions/setup-node-env/action.yml", "utf8"));
const step = action.runs.steps.find(
  (candidate: { name: string }) => candidate.name === "Prepare Git capabilities",
);

describe.skipIf(process.platform === "win32")("CI Git capability setup", () => {
  function fixture(
    options: { capable?: boolean; ubuntu?: boolean; uid?: string; repositoryTool?: boolean } = {},
  ) {
    const root = tempDirs.make("openclaw-git-capability-");
    const bin = path.join(root, "bin");
    const log = path.join(root, "commands");
    const capable = path.join(root, "capable");
    const osRelease = path.join(root, "os-release");
    mkdirSync(bin);
    writeFileSync(log, "");
    writeFileSync(osRelease, `ID=${options.ubuntu === false ? "debian" : "ubuntu"}\n`);
    if (options.capable) {
      writeFileSync(capable, "");
    }
    const shell = (file: string, body: string) =>
      writeFileSync(file, `#!/bin/bash\nset -euo pipefail\n${body}\n`, { mode: 0o755 });
    shell(
      path.join(bin, "git"),
      `
if [[ "$*" == --version ]]; then
  [[ -f "$FIXTURE_CAPABLE" ]] && echo 'git version 2.56.0' || echo 'git version 2.43.0'
elif [[ "$*" == '--no-lazy-fetch --version' && -f "$FIXTURE_CAPABLE" ]]; then
  echo 'git version 2.56.0'
else
  echo 'unknown option: --no-lazy-fetch' >&2
  exit 129
fi`,
    );
    shell(path.join(bin, "id"), `echo '${options.uid ?? "1000"}'`);
    shell(
      path.join(bin, "timeout"),
      `
printf 'timeout %s\\n' "$*" >> "$FIXTURE_LOG"
shift 3
exec "$@"`,
    );
    shell(
      path.join(bin, "sudo"),
      `
printf 'sudo %s\\n' "$*" >> "$FIXTURE_LOG"
[[ "$1" == -n ]]
shift
exec "$@"`,
    );
    const repositoryTool = path.join(root, "repository-tool");
    shell(repositoryTool, `printf 'repository %s\\n' "$*" >> "$FIXTURE_LOG"`);
    if (options.repositoryTool !== false) {
      copyFileSync(repositoryTool, path.join(bin, "add-apt-repository"));
    }
    shell(
      path.join(bin, "apt-get"),
      `
printf 'apt %s noninteractive=%s\\n' "$*" "$DEBIAN_FRONTEND" >> "$FIXTURE_LOG"
[[ "\${FIXTURE_INSTALL_FAIL:-}" != true ]] || exit 100
if [[ "$*" == *'software-properties-common' ]]; then
  cp "$FIXTURE_REPOSITORY_TOOL" "$FIXTURE_BIN/add-apt-repository"
elif [[ "$*" == *'--no-install-recommends git' && "\${FIXTURE_POST_FAIL:-}" != true ]]; then
  : > "$FIXTURE_CAPABLE"
fi`,
    );
    for (const [command, executable] of [
      ["env", "/usr/bin/env"],
      ["grep", "/usr/bin/grep"],
      ["cp", "/bin/cp"],
      ["bash", "/bin/bash"],
    ] as const) {
      symlinkSync(executable, path.join(bin, command));
    }
    // Keep actual OS parsing and setup intact; only relocate its read-only host fact.
    writeFileSync(
      path.join(root, "ensure-git.sh"),
      readFileSync(helper, "utf8").replace("/etc/os-release", osRelease),
    );
    const run = (extra: Record<string, string> = {}) =>
      spawnSync("/bin/bash", ["-c", step.run], {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: bin,
          GITHUB_ACTION_PATH: root,
          FIXTURE_LOG: log,
          FIXTURE_CAPABLE: capable,
          FIXTURE_BIN: bin,
          FIXTURE_REPOSITORY_TOOL: repositoryTool,
          ...extra,
        },
      });
    return { run, commands: () => readFileSync(log, "utf8"), capable };
  }

  it("keeps capable Git without any privileged or package command", () => {
    expect(step.if).toBe("runner.os == 'Linux'");
    const setup = fixture({ capable: true, ubuntu: false });
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("git version 2.56.0");
    expect(setup.commands()).toBe("");
  });

  it.each(["0", "1000"])("upgrades Ubuntu Git under UID %s and verifies its capability", (uid) => {
    const setup = fixture({ uid });
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("git version 2.43.0");
    expect(result.stdout).toContain("git version 2.56.0");
    expect(existsSync(setup.capable)).toBe(true);
    const commands = setup.commands();
    expect(commands).toContain("repository --yes --no-update ppa:git-core/ppa");
    expect(commands).toContain("Acquire::http::Timeout=30");
    expect(commands).toContain("Acquire::https::Timeout=30");
    expect(commands).toContain("Acquire::Retries=0");
    expect(commands).toContain(
      "install -y --no-install-recommends git noninteractive=noninteractive",
    );
    expect(commands.match(/^timeout /gm)).toHaveLength(3);
    expect(commands.includes("sudo -n")).toBe(uid !== "0");
  });

  it("installs the Ubuntu repository tool only when missing", () => {
    const setup = fixture({ repositoryTool: false });
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    expect(setup.commands()).toContain(
      "install -y --no-install-recommends software-properties-common",
    );
    expect(setup.commands().match(/^timeout /gm)).toHaveLength(5);
  });

  it("rejects unsupported non-Ubuntu Git without package changes", () => {
    const setup = fixture({ ubuntu: false });
    const result = setup.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git 2.45 or newer with --no-lazy-fetch support");
    expect(setup.commands()).toBe("");
  });

  it.each(["FIXTURE_INSTALL_FAIL", "FIXTURE_POST_FAIL"])("fails closed on %s", (failure) => {
    const setup = fixture();
    const result = setup.run({ [failure]: "true" });
    expect(result.status).not.toBe(0);
    expect(existsSync(setup.capable)).toBe(false);
    if (failure === "FIXTURE_POST_FAIL") {
      expect(result.stderr).toContain("Git upgrade did not provide --no-lazy-fetch support");
    } else {
      expect(setup.commands()).not.toContain("install -y --no-install-recommends git");
    }
  });
});
