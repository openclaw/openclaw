import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  unlinkSync,
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
    options: { capable?: boolean; ubuntu?: boolean; uid?: string; codename?: string } = {},
  ) {
    const root = tempDirs.make("openclaw-git-capability-");
    const bin = path.join(root, "bin");
    const log = path.join(root, "commands");
    const capable = path.join(root, "capable");
    const etc = path.join(root, "etc");
    const osRelease = path.join(etc, "os-release");
    const key = path.join(etc, "apt/keyrings/openclaw-git-core-ppa.asc");
    const source = path.join(etc, "apt/sources.list.d/openclaw-git-core-ppa.list");
    const unrelatedSource = path.join(etc, "apt/sources.list.d/unrelated.list");
    mkdirSync(path.dirname(source), { recursive: true });
    writeFileSync(unrelatedSource, "existing source\n");
    mkdirSync(bin);
    writeFileSync(log, "");
    writeFileSync(
      osRelease,
      `ID=${options.ubuntu === false ? "debian" : "ubuntu"}\nVERSION_CODENAME=${JSON.stringify(options.codename ?? "noble")}\n`,
    );
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
    shell(
      path.join(bin, "add-apt-repository"),
      "echo 'Launchpad discovery unavailable' >&2; exit 42",
    );
    shell(
      path.join(bin, "install"),
      `
printf 'install %s\\n' "$*" >> "$FIXTURE_LOG"
args=()
while (( $# )); do
  case "$1" in
    -o|-g) shift 2 ;;
    *) args+=("$1"); shift ;;
  esac
done
exec /usr/bin/install "\${args[@]}"`,
    );
    shell(
      path.join(bin, "apt-get"),
      `
printf 'apt %s noninteractive=%s\\n' "$*" "$DEBIAN_FRONTEND" >> "$FIXTURE_LOG"
[[ "\${FIXTURE_INSTALL_FAIL:-}" != true ]] || exit 100
if [[ "$*" == *'--no-install-recommends git' ]]; then
  attempt=0
  [[ ! -f "$FIXTURE_CAPABLE.attempts" ]] || read -r attempt < "$FIXTURE_CAPABLE.attempts"
  attempt=$((attempt + 1))
  printf '%s\\n' "$attempt" > "$FIXTURE_CAPABLE.attempts"
  (( attempt > \${FIXTURE_INSTALL_FAILURES:-0} )) || exit 100
  [[ "\${FIXTURE_POST_FAIL:-}" == true ]] || : > "$FIXTURE_CAPABLE"
fi`,
    );
    shell(path.join(bin, "sleep"), `printf 'sleep %s\\n' "$*" >> "$FIXTURE_LOG"`);
    for (const [command, executable] of [
      ["env", "/usr/bin/env"],
      ["grep", "/usr/bin/grep"],
      ["mktemp", "/usr/bin/mktemp"],
      ["rm", "/bin/rm"],
      ["bash", "/bin/bash"],
    ] as const) {
      symlinkSync(executable, path.join(bin, command));
    }
    // Keep actual OS parsing and file installation; relocate only the host /etc paths.
    writeFileSync(
      path.join(root, "ensure-git.sh"),
      readFileSync(helper, "utf8").replaceAll("/etc/", `${etc}/`),
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
          ...extra,
        },
      });
    return {
      run,
      commands: () => readFileSync(log, "utf8"),
      capable,
      key,
      source,
      unrelatedSource,
    };
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
    expect(readFileSync(setup.source, "utf8")).toBe(
      `deb [signed-by=${setup.key}] https://ppa.launchpadcontent.net/git-core/ppa/ubuntu noble main\n`,
    );
    expect(createHash("sha256").update(readFileSync(setup.key)).digest("hex")).toBe(
      "e1175fa6e5170e9bc91973756ada1c8d65d2f2059442c520146042a52dbc8664",
    );
    expect(statSync(setup.key).mode & 0o777).toBe(0o644);
    expect(statSync(setup.source).mode & 0o777).toBe(0o644);
    expect(commands).toContain("install -o root -g root -m 0644");
    expect(commands).toContain("Acquire::http::Timeout=30");
    expect(commands).toContain("Acquire::https::Timeout=30");
    expect(commands).toContain("Acquire::Retries=0");
    expect(commands).toContain(
      "install -y --no-install-recommends git noninteractive=noninteractive",
    );
    expect(commands.match(/^timeout /gm)).toHaveLength(2);
    expect(commands.includes("sudo -n")).toBe(uid !== "0");
  });

  it("replaces only its dedicated PPA files on another required upgrade", () => {
    const setup = fixture();
    expect(setup.run().status).toBe(0);
    writeFileSync(setup.key, "stale key");
    writeFileSync(setup.source, "stale source");
    unlinkSync(setup.capable);
    expect(setup.run().status).toBe(0);
    expect(readFileSync(setup.key, "utf8")).toContain("BEGIN PGP PUBLIC KEY BLOCK");
    expect(readFileSync(setup.source, "utf8")).toContain("noble main\n");
    expect(readFileSync(setup.unrelatedSource, "utf8")).toBe("existing source\n");
  });

  it.each([
    { failures: "1", status: 0, installs: 2 },
    { failures: "3", status: 100, installs: 3 },
  ])(
    "settles Git installation after $failures package failures",
    ({ failures, status, installs }) => {
      const setup = fixture();
      const result = setup.run({ FIXTURE_INSTALL_FAILURES: failures });
      expect(result.status, result.stderr).toBe(status);
      expect(existsSync(setup.capable)).toBe(status === 0);
      const commands = setup.commands();
      expect(commands.match(/^apt .* update /gm)).toHaveLength(1);
      expect(commands.match(/^apt .* install /gm)).toHaveLength(installs);
      expect(commands.match(/^sleep 2$/gm)).toHaveLength(installs - 1);
      expect(commands.match(/^timeout /gm)).toHaveLength(2);
    },
  );

  it.each(["", "noble extra", "../noble"])(
    "rejects invalid codename %j before privileged writes",
    (codename) => {
      const setup = fixture({ codename });
      const result = setup.run();
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Ubuntu VERSION_CODENAME is missing or invalid");
      expect(setup.commands()).toBe("");
      expect(existsSync(setup.source)).toBe(false);
    },
  );

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
