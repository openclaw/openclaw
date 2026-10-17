import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path, { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const scriptPath = "scripts/build-and-run-mac.sh";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runStopExistingLocalApp(params: { fakeLsof?: string; fakePgrep: string }) {
  const root = tempDirs.make("openclaw-build-run-mac-test-");
  const binDir = join(root, "bin");
  const killCallsPath = join(root, "kill-calls.txt");
  const pgrepCallsPath = join(root, "pgrep-calls.txt");
  mkdirSync(binDir);

  for (const [name, body] of [
    ["pgrep", params.fakePgrep],
    [
      "lsof",
      params.fakeLsof ??
        `#!/usr/bin/env bash
pid=''
while [[ $# -gt 0 ]]; do
  if [[ "$1" == "-p" ]]; then pid="$2"; shift 2; continue; fi
  shift
done
printf "p%s\\n" "$pid"
printf "n/worktree/apps/macos\\n"
exit 0`,
    ],
    [
      "sed",
      `#!/usr/bin/env bash
if [[ "$1" == "-n" && "$2" == "s/^n//p" ]]; then
  /usr/bin/sed -n 's/^n//p'
else
  /usr/bin/sed "$@"
fi`,
    ],
    [
      "head",
      `#!/usr/bin/env bash
exec /usr/bin/head "$@"`,
    ],
    ["sleep", "#!/usr/bin/env bash\nexit 0\n"],
  ] as const) {
    const toolPath = join(binDir, name);
    writeFileSync(toolPath, body);
    chmodSync(toolPath, 0o755);
  }

  const script = readFileSync(scriptPath, "utf8");
  const stopFunction = script.slice(
    script.indexOf("process_cwd_matches()"),
    script.indexOf('printf "\\n▶️  Building'),
  );
  const harnessPath = join(root, "stop-existing-local-app.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'BIN_ABS="/worktree/apps/macos/.build-local/debug/OpenClaw"',
      'BIN=".build-local/debug/OpenClaw"',
      'APP_CWD="/worktree/apps/macos"',
      "kill() {",
      '  printf "%s\\n" "$*" >> "$OPENCLAW_TEST_KILL_CALLS"',
      '  touch "$OPENCLAW_TEST_KILLED_MARKER"',
      "  return 0",
      "}",
      stopFunction,
      "stop_existing_local_app",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  const result = spawnSync("/bin/bash", [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_TEST_KILLED_MARKER: join(root, "killed"),
      OPENCLAW_TEST_KILL_CALLS: killCallsPath,
      OPENCLAW_TEST_PGREP_CALLS: pgrepCallsPath,
      OPENCLAW_TEST_PGREP_COUNT: join(root, "pgrep-count.txt"),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  const killCalls = existsSync(killCallsPath) ? readFileSync(killCallsPath, "utf8") : "";
  const pgrepCalls = existsSync(pgrepCallsPath) ? readFileSync(pgrepCallsPath, "utf8") : "";
  return { killCalls, pgrepCalls, result };
}

describe("scripts/build-and-run-mac.sh", () => {
  it("rejects unknown options before build or launch side effects", () => {
    const result = spawnSync("/bin/bash", [scriptPath, "--wat"], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("ERROR: Unknown build-and-run-mac option: --wat");
  });

  it("keeps launch logs isolated unless an explicit log path is provided", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain('cd "$APP_DIR"');
    expect(script).toContain(
      'LOG_PATH="${OPENCLAW_MAC_RUN_LOG:-$(mktemp "${TMPDIR:-/tmp}/openclaw-${PRODUCT}.XXXXXX.log")}"',
    );
    expect(script).toContain('nohup "$BIN_ABS" >"$LOG_PATH" 2>&1 &');
    expect(script).toContain('printf "Started $PRODUCT (PID $PID). Logs: $LOG_PATH\\n"');
    expect(script).not.toContain("/tmp/openclaw.log");
  });

  it("stops only the local debug app binary before relaunching", () => {
    const script = readFileSync(scriptPath, "utf8");
    const { killCalls, pgrepCalls, result } = runStopExistingLocalApp({
      fakePgrep: `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OPENCLAW_TEST_PGREP_CALLS"
count="$(cat "$OPENCLAW_TEST_PGREP_COUNT" 2>/dev/null || echo 0)"
next="$((count + 1))"
printf "%s\\n" "$next" > "$OPENCLAW_TEST_PGREP_COUNT"
if [[ "$2" == "/worktree/apps/macos/.build-local/debug/OpenClaw" ]]; then exit 1; fi
if [[ "$2" == ".build-local/debug/OpenClaw" && "$count" == "1" ]]; then echo 321; exit 0; fi
exit 1`,
    });

    expect(result.status).toBe(0);
    expect(killCalls).toBe("321\n");
    expect(pgrepCalls).toContain("-f /worktree/apps/macos/.build-local/debug/OpenClaw");
    expect(pgrepCalls).toContain("-f .build-local/debug/OpenClaw");
    expect(script).toContain('BIN_ABS="$(pwd)/$BIN"');
    expect(script).toContain('pgrep -f "$BIN_ABS"');
    expect(script).toContain('pgrep -f "$BIN"');
    expect(script).toContain('kill "$pid"');
    expect(script).not.toContain('killall -q "$PRODUCT"');
    expect(script).not.toContain("pkill");
  });

  it("fails when the scoped local app process survives cleanup", () => {
    const { result } = runStopExistingLocalApp({
      fakePgrep: `#!/usr/bin/env bash
if [[ "$2" == ".build-local/debug/OpenClaw" ]]; then echo 321; exit 0; fi
exit 1`,
    });

    expect(result.status).toBe(1);
  });
});

function scriptPaths(files: string) {
  return files
    .trim()
    .split(/\s+/u)
    .map((file) => `scripts/${file}`);
}

// Platform contract: macOS tooling must not select Homebrew Bash through PATH.
const nativeScripts = scriptPaths(`
lib/plistbuddy.sh e2e/parallels-linux-smoke.sh e2e/parallels-windows-smoke.sh
e2e/parallels-npm-update-smoke.sh apple-release-source-check.sh build-and-run-mac.sh
check-swift-tools.sh codesign-mac-app.sh create-dmg.sh dev/computer-use-macos-live-rig.sh
e2e/parallels-macos-smoke.sh e2e/parallels-windows-prepare.sh format-swift.sh
generate-mac-app-icons.sh install-swift-tools.sh ios-app-store-connect-keychain-setup.sh
ios-configure-signing.sh ios-release-archive.sh ios-release-cut.sh ios-release-plan.sh
ios-release-prepare.sh ios-release-upload.sh ios-run.sh ios-screenshots.sh ios-team-id.sh
ios-validate-app-store-ipa.sh ios-write-version-xcconfig.sh lib/ios-fastlane.sh
lib/mac-app-bundle.sh lib/mac-disk-image.sh lib/mac-swift-build.sh lib/restart-mac-gateway.sh
lib/swift-toolchain.sh lint-swift.sh mac-elevation-host.sh make_appcast.sh notarize-mac-artifact.sh
package-mac-app.sh package-mac-dist.sh restart-mac.sh stage-cloudflared-macos.sh
stage-cua-driver-macos.sh stage-mac-runtime.sh test-macos-health-render.sh
`);

// Includes host wrappers whose sourced Docker helpers use heredocs.
const portableScripts = scriptPaths(`
android-release-upload.sh android-screenshots.sh changelog-to-html.sh ci-hydrate-live-auth.sh
ci-hydrate-testbox-env.sh dev/computer-use-macos-live-rig.sh docker/setup.sh
docker/shared-image-artifact.sh docs-spellcheck.sh e2e/agent-bundle-mcp-tools-docker.sh
e2e/agents-delete-shared-workspace-docker.sh e2e/browser-cdp-snapshot-docker.sh
e2e/browser-plugin-profiles-docker.sh e2e/build-image.sh e2e/bun-global-install-smoke.sh
e2e/bundled-plugin-install-uninstall-docker.sh e2e/cli-installer-distribution-docker.sh
e2e/codex-media-path-docker.sh e2e/codex-npm-plugin-live-docker.sh e2e/codex-on-demand-docker.sh
e2e/compose-setup.sh e2e/config-reload-source-docker.sh e2e/cron-cli-docker.sh
e2e/cron-mcp-cleanup-docker.sh e2e/docker-package-install.sh e2e/docker-selected-plugins.sh
e2e/doctor-install-switch-docker.sh e2e/gateway-concurrency-docker.sh e2e/gateway-network-docker.sh
e2e/kitchen-sink-plugin-docker.sh e2e/kitchen-sink-rpc-docker.sh e2e/live-plugin-tool-docker.sh
e2e/mcp-channels-docker.sh e2e/mcp-code-mode-gateway-docker.sh
e2e/mcp-code-mode-gateway-live-docker.sh e2e/multi-node-update-docker.sh
e2e/npm-onboard-channel-agent-docker.sh e2e/npm-telegram-live-docker.sh e2e/onboard-docker.sh
e2e/openai-chat-tools-docker.sh e2e/openai-image-auth-docker.sh
e2e/openai-web-search-minimal-docker.sh e2e/openwebui-docker.sh
e2e/plugin-binding-command-escape-docker.sh e2e/plugin-lifecycle-matrix-docker.sh
e2e/plugin-update-unchanged-docker.sh e2e/plugins-docker.sh e2e/qr-import-docker.sh
e2e/release-media-memory-docker.sh e2e/release-plugin-marketplace-docker.sh
e2e/release-typed-onboarding-docker.sh e2e/release-upgrade-user-journey-docker.sh
e2e/release-user-journey-docker.sh e2e/sandbox-browser-sidecar-docker.sh
e2e/session-runtime-context-docker.sh e2e/skill-install-docker.sh
e2e/system-agent-first-run-docker.sh e2e/system-agent-rescue-docker.sh
e2e/update-channel-switch-docker.sh e2e/update-corrupt-plugin-docker.sh
e2e/update-first-hop-compat-docker.sh e2e/upgrade-survivor-docker.sh
github/find-reusable-release-validation.sh github/resolve-openclaw-ref.sh
github/resolve-release-check-artifacts.sh k8s/create-kind.sh k8s/deploy.sh plugin-clawhub-publish.sh
plugin-npm-publish.sh podman/setup.sh pr release-telegram-provenance.sh run-openclaw-podman.sh
run-opengrep.sh sandbox-browser-setup.sh sandbox-common-setup.sh sandbox-setup.sh
test-cleanup-docker.sh test-install-sh-docker.sh test-install-sh-e2e-docker.sh
test-live-acp-bind-docker.sh test-live-build-docker.sh test-live-cli-backend-docker.sh
test-live-codex-harness-docker.sh test-live-gateway-models-docker.sh test-live-models-docker.sh
test-live-subagent-announce-docker.sh update-gateway.sh
`);

const guard =
  '# Bash 5.3+ can deadlock writing heredoc pipes on macOS before the reader starts.\nif [[ ${OSTYPE:-} == darwin* && $BASH != /bin/bash ]] && ((BASH_VERSINFO[0] > 5 || (BASH_VERSINFO[0] == 5 && BASH_VERSINFO[1] >= 3))); then\n  exec /bin/bash "$0" "$@"\nfi\n';

// bash -n accepts unknown builtins and expansions that only fail at runtime.
// This deliberately conservative scan includes embedded shell payloads, ignores
// full-line comments, and is not a shell parser. Keep compatibility exceptions
// empty; a future exception must name its file and explain its interpreter boundary.
const bash4Patterns: [string, RegExp][] = [
  ["modern builtin", /\b(?:mapfile|readarray|coproc)\b/u],
  [
    "associative array, nameref, or case attribute",
    /(?<![\w-])(?:declare|typeset|local|readonly)\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[Anlu]/u,
  ],
  ["case conversion", /\$\{[a-zA-Z_][\w]*(?:\[[^\]]*\])?[,^]/u],
  ["negative array index", /\$\{[^}\n]*\[\s*-\s*\d/u],
  ["name enumeration", /\$\{![a-zA-Z_]\w*[@*]\}/u],
  ["parameter transformation", /\$\{[^}\n]*@[a-zA-Z]\}/u],
  ["modern redirection or case fallthrough", /\|&|&>>|;;&|;&/u],
  ["array printf destination", /\bprintf\s+-v\s+["']?[^\s"']*\[/u],
  ["variable existence conditional", /(?:\[\[|&&|\|\|)\s*(?:!\s*)?(?:\(\s*)?-v\s/u],
  ["modern wait option", /\bwait\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[npf]\b/u],
  ["allocated file descriptor", /(?<![$\w])\{[a-zA-Z_]\w*\}\s*[<>]/u],
  ["fixed-length read", /\bread\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*N/u],
  [
    "modern shell option",
    /\bshopt\s+[^\n]*\b(?:globstar|lastpipe|inherit_errexit|assoc_expand_once|localvar_inherit|localvar_unset)\b/u,
  ],
];

function bash4Findings(source: string): string[] {
  return source.split("\n").flatMap((line, index) => {
    if (line.trimStart().startsWith("#")) {
      return [];
    }
    return bash4Patterns
      .filter(([, pattern]) => pattern.test(line))
      .map(([name]) => `${index + 1}: ${name}: ${line.trim()}`);
  });
}

function bash32Sources(): Map<string, string> {
  const files = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  )
    .split("\0")
    .filter(
      (file) =>
        file &&
        (!path.extname(file) || file.endsWith(".sh")) &&
        existsSync(file) &&
        statSync(file).isFile(),
    );
  const shells = new Map(files.map((file) => [file, readFileSync(file, "utf8")]));
  const selected = new Map(
    [...shells].filter(
      ([file, source]) =>
        source.startsWith("#!/bin/bash\n") ||
        /exec \/bin\/bash/u.test(source) ||
        // Include whole helper directories: some callers select a helper via a
        // variable, and Docker payloads source scripts inside their container.
        /^scripts\/(?:lib|pr-lib|e2e\/lib|docker\/install-sh-common)\/.*\.sh$/u.test(file),
    ),
  );
  for (const source of selected.values()) {
    // Match literal source basenames regardless of ROOT_DIR/SCRIPT_DIR spelling.
    // Include all matches when a basename is shared, then visit their sources too.
    // Operator profiles and generated env files are not repository libraries.
    for (const match of source.matchAll(
      /(?:^|[;\s])(?:source|\.)\s+["']?[^\s"']*?([\w.-]+\.sh)(?=["'\s;]|$)/gmu,
    )) {
      for (const [file, contents] of shells) {
        if (path.posix.basename(file) === match[1]) {
          selected.set(file, contents);
        }
      }
    }
  }
  return selected;
}

describe("macOS Bash selection", () => {
  it("keeps system-Bash entrypoints and their sourced libraries compatible with Bash 3.2", () => {
    const findings = [...bash32Sources()].flatMap(([file, source]) =>
      bash4Findings(source).map((finding) => `${file}:${finding}`),
    );
    expect(findings).toEqual([]);
  });

  it("keeps package commands from overriding native script shebangs through PATH", () => {
    const { scripts } = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    for (const [name, command] of Object.entries(scripts)) {
      if (/^(ios:|mac:|test:parallels:)/u.test(name)) {
        expect(command, name).not.toMatch(/(^|[;&|]\s*)bash\s/u);
      }
    }
  });

  it.each(nativeScripts)("pins %s to the system Bash", (filename) => {
    expect(readFileSync(filename, "utf8").split("\n")[0]).toBe("#!/bin/bash");
  });

  it.each(portableScripts)("guards %s before any heredoc can run", (filename) => {
    const source = readFileSync(filename, "utf8");
    expect(source.slice(source.indexOf("\n") + 1).startsWith(guard)).toBe(true);
  });

  it.skipIf(process.platform !== "darwin")(
    "reexecs modern Bash with arguments intact and preserves system Bash",
    () => {
      const root = tempDirs.make("openclaw-bash-guard-");
      const script = path.join(root, "script with [glob] spaces.sh");
      writeFileSync(script, `#!/usr/bin/env bash\n${guard}printf '%s\n' "$BASH" "$@"\n`);
      for (const shell of ["/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash"].filter(
        existsSync,
      )) {
        const version = spawnSync(shell, ["-c", "printf '%s' \"$BASH_VERSION\""], {
          encoding: "utf8",
        });
        const [major = 0, minor = 0] = version.stdout.split(".").map(Number);
        if (shell !== "/bin/bash" && !(major > 5 || (major === 5 && minor >= 3))) {
          continue;
        }
        const result = spawnSync(shell, [script, "argument with spaces", "", "*[literal]"], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toBe("/bin/bash\nargument with spaces\n\n*[literal]\n");
      }
    },
  );

  it.skipIf(process.platform !== "darwin").each(["install.sh", "install-cli.sh"])(
    "reexecs file execution and rejects sourcing of %s",
    (filename) => {
      const root = tempDirs.make("openclaw-installer-bash-guard-");
      const script = path.join(root, filename);
      const source = readFileSync(path.join("scripts", filename), "utf8");
      const prelude = source.slice(0, source.indexOf("set -euo pipefail"));
      expect(prelude).toContain('exec /bin/bash "$0" "$@"');
      const probe = `${prelude}printf '%s\n' "$BASH" "$@"\n`;
      writeFileSync(script, probe);
      for (const shell of ["/opt/homebrew/bin/bash", "/usr/local/bin/bash"].filter(existsSync)) {
        const version = spawnSync(shell, ["-c", "printf '%s' \"$BASH_VERSION\""], {
          encoding: "utf8",
        });
        const [major = 0, minor = 0] = version.stdout.split(".").map(Number);
        if (!(major > 5 || (major === 5 && minor >= 3))) {
          continue;
        }
        const direct = spawnSync(shell, [script, "kept argument"], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(direct.status, direct.stderr).toBe(0);
        expect(direct.stdout).toBe("/bin/bash\nkept argument\n");
        const sourced = spawnSync(shell, ["-c", 'source "$1"', "installer-source", script], {
          encoding: "utf8",
          timeout: 5000,
        });
        expect(sourced.status).toBe(1);
        expect(sourced.stdout).toBe("");
        expect(sourced.stderr).toContain("Run this installer with /bin/bash on macOS");
      }
    },
  );
});
