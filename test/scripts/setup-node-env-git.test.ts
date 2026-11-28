import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
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
  function fixture(options: { capable?: boolean; codename?: string } = {}) {
    const root = tempDirs.make("openclaw-git-capability-");
    const bin = path.join(root, "bin");
    const actionPath = path.join(root, path.dirname(helper));
    const githubPath = path.join(root, "github-path");
    const log = path.join(root, "commands");
    const archive = "test Git package";
    mkdirSync(bin);
    mkdirSync(actionPath, { recursive: true });
    writeFileSync(githubPath, "");
    writeFileSync(log, "");
    writeFileSync(
      path.join(root, "os-release"),
      `ID=ubuntu\nVERSION_CODENAME=${options.codename ?? "noble"}\n`,
    );
    const shell = (file: string, body: string) =>
      writeFileSync(path.join(bin, file), `#!/bin/bash\nset -euo pipefail\n${body}\n`, {
        mode: 0o755,
      });
    shell(
      "git",
      options.capable
        ? "echo git version 2.56.0"
        : `
[[ "$*" == --version ]] || exit 129
echo git version 2.43.0`,
    );
    shell("apt-get", `echo "Simulated Git PPA index outage: HTTP 503" >&2; exit 100`);
    shell(
      "curl",
      `
while [[ "$1" != --output ]]; do shift; done
printf '%s\\n' "$3" >> "$FIXTURE_LOG"
if [[ "$FIXTURE_PRIMARY_DOWN" == true && "$3" == https://deb.debian.org/* ]]; then exit 22; fi
printf '%s' "${archive}$FIXTURE_CORRUPTION" > "$2"`,
    );
    shell(
      "dpkg-deb",
      `
printf 'extract\\n' >> "$FIXTURE_LOG"
mkdir -p "$3/usr/bin" "$3/usr/lib/git-core"
cp "$FIXTURE_REPLACEMENT" "$3/usr/bin/git"
printf 'git version 2.47.3\\n' > "$3/usr/lib/git-core/version"`,
    );
    shell(
      "replacement-git",
      `
[[ "$*" == "--no-lazy-fetch --version" ]] || exit 129
cat "$GIT_EXEC_PATH/version"`,
    );
    shell("sha256sum", `exec /usr/bin/shasum -a 256 "$@"`);
    for (const command of ["env", "bash", "mktemp", "mkdir", "cp", "cat", "rm", "chmod"]) {
      symlinkSync(
        command === "bash" ? "/bin/bash" : `/usr/bin/${command}`,
        path.join(bin, command),
      );
    }
    // Use real checksum validation with synthetic bytes, and never touch the runner /etc.
    writeFileSync(
      path.join(root, helper),
      readFileSync(helper, "utf8")
        .replaceAll("/etc/", `${root}/`)
        .replace(
          /checksum=[a-f0-9]{64}/g,
          `checksum=${createHash("sha256").update(archive).digest("hex")}`,
        ),
    );
    const run = (extra: Record<string, string> = {}, script = step.run) =>
      spawnSync("/bin/bash", ["-c", script], {
        cwd: root,
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: bin,
          GITHUB_ACTION_PATH: actionPath,
          RUNNER_ARCH: "X64",
          RUNNER_TEMP: root,
          GITHUB_PATH: githubPath,
          FIXTURE_LOG: log,
          FIXTURE_REPLACEMENT: path.join(bin, "replacement-git"),
          FIXTURE_PRIMARY_DOWN: "false",
          FIXTURE_CORRUPTION: "",
          ...extra,
        },
      });
    const nextPath = () => readFileSync(githubPath, "utf8").trim();
    const runNextStep = () =>
      spawnSync("/bin/bash", ["-c", "git --no-lazy-fetch --version"], {
        encoding: "utf8",
        timeout: 5_000,
        env: { PATH: [nextPath(), bin].join(path.delimiter) },
      });
    return { run, runNextStep, nextPath, commands: () => readFileSync(log, "utf8") };
  }

  it("keeps capable Git without downloading or changing PATH", () => {
    expect(step.if).toBe("runner.os == 'Linux'");
    const setup = fixture({ capable: true, codename: "jammy" });
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("git version 2.56.0");
    expect(setup.commands()).toBe("");
    expect(setup.nextPath()).toBe("");
  });

  it("provides capable Git when the Noble Git PPA is unavailable", () => {
    const setup = fixture();
    const result = setup.run();
    expect(result.status, result.stderr).toBe(0);
    const next = setup.runNextStep();
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toBe("git version 2.47.3\n");
  });

  it("provides capable Git to subsequent Crabbox hydration steps", () => {
    const workflow = parse(readFileSync(".github/workflows/crabbox-hydrate.yml", "utf8"));
    const hydrateStep = workflow.jobs.hydrate.steps.find(
      (candidate: { name?: string }) => candidate.name === "Prepare Git capabilities",
    );
    const setup = fixture();
    const result = setup.run({}, hydrateStep?.run ?? "");
    expect(result.status, result.stderr).toBe(0);
    const next = setup.runNextStep();
    expect(next.status, next.stderr).toBe(0);
    expect(next.stdout).toBe("git version 2.47.3\n");
  });

  it("recovers from a missing primary package using the pinned snapshot", () => {
    const setup = fixture();
    const result = setup.run({ FIXTURE_PRIMARY_DOWN: "true" });
    expect(result.status, result.stderr).toBe(0);
    expect(setup.commands()).toContain("https://snapshot.debian.org/");
    expect(setup.runNextStep().status).toBe(0);
  });

  it("rejects corrupt package bytes before extracting or changing PATH", () => {
    const setup = fixture();
    const result = setup.run({ FIXTURE_CORRUPTION: "corrupt" });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("FAILED");
    expect(setup.commands()).not.toContain("extract");
    expect(setup.nextPath()).toBe("");
  });

  it("rejects an unsupported image with old Git without downloading", () => {
    const setup = fixture({ codename: "jammy" });
    const result = setup.run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git 2.45 or newer with --no-lazy-fetch support");
    expect(setup.commands()).toBe("");
    expect(setup.nextPath()).toBe("");
  });
});
