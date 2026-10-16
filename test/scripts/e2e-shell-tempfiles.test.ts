// E2E Shell Tempfiles tests cover e2e shell tempfiles script behavior.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

// Reviewed public SKILL.md from @steipete/gifgrep 1.0.1; data, never executed.
const maintainedSkillText = [
  "---",
  "name: gifgrep",
  "description: Search GIF providers with CLI/TUI, download results, and extract stills/sheets.",
  "homepage: https://gifgrep.com",
  'metadata: {"clawdbot":{"emoji":"\u{1f9f2}","requires":{"bins":["gifgrep"]},"install":[{"id":"brew","kind":"brew","formula":"steipete/tap/gifgrep","bins":["gifgrep"],"label":"Install gifgrep (brew)"},{"id":"go","kind":"go","module":"github.com/steipete/gifgrep/cmd/gifgrep@latest","bins":["gifgrep"],"label":"Install gifgrep (go)"}]}}',
  "---",
  "",
  "# gifgrep",
  "",
  "Use `gifgrep` to search GIF providers (Tenor/Giphy), browse in a TUI, download results, and extract stills or sheets.",
  "",
  "GIF-Grab (gifgrep workflow)",
  "- Search \u2192 preview \u2192 download \u2192 extract (still/sheet) for fast review and sharing.",
  "",
  "Quick start",
  "- `gifgrep cats --max 5`",
  "- `gifgrep cats --format url | head -n 5`",
  "- `gifgrep search --json cats | jq '.[0].url'`",
  '- `gifgrep tui "office handshake"`',
  "- `gifgrep cats --download --max 1 --format url`",
  "",
  "TUI + previews",
  '- TUI: `gifgrep tui "query"`',
  "- CLI still previews: `--thumbs` (Kitty/Ghostty only; still frame)",
  "",
  "Download + reveal",
  "- `--download` saves to `~/Downloads`",
  "- `--reveal` shows the last download in Finder",
  "",
  "Stills + sheets",
  "- `gifgrep still ./clip.gif --at 1.5s -o still.png`",
  "- `gifgrep sheet ./clip.gif --frames 9 --cols 3 -o sheet.png`",
  "- Sheets = single PNG grid of sampled frames (great for quick review, docs, PRs, chat).",
  "- Tune: `--frames` (count), `--cols` (grid width), `--padding` (spacing).",
  "",
  "Providers",
  "- `--source auto|tenor|giphy`",
  "- `GIPHY_API_KEY` required for `--source giphy`",
  "- `TENOR_API_KEY` optional (Tenor demo key used if unset)",
  "",
  "Output",
  "- `--json` prints an array of results (`id`, `title`, `url`, `preview_url`, `tags`, `width`, `height`)",
  "- `--format` for pipe-friendly fields (e.g., `url`)",
  "",
  "Environment tweaks",
  "- `GIFGREP_SOFTWARE_ANIM=1` to force software animation",
  "- `GIFGREP_CELL_ASPECT=0.5` to tweak preview geometry",
  "",
].join("\n");

const maintainedRawRow = {
  slug: "gifgrep",
  ownerHandle: "steipete",
  source: "clawhub",
  install: { kind: "clawhub", reference: "steipete/gifgrep" },
};
const maintainedMappedRow = {
  slug: "gifgrep",
  ownerHandle: "steipete",
  installRef: "@steipete/gifgrep",
};

async function runClawhubInstallProof(options: {
  results: Record<string, unknown>[];
  overrides?: Record<string, string>;
  origin?: Record<string, unknown>;
  lock?: Record<string, unknown>;
  skillText?: string;
  refusal?: boolean;
}) {
  const root = tempDirs.make("openclaw-clawhub-maintained-");
  const bin = path.join(root, "bin");
  const scratch = path.join(root, "scratch");
  const callsPath = path.join(root, "calls.jsonl");
  const fixturePath = path.join(root, "fixture.json");
  const redactorPath = path.join(root, "redactor.mjs");
  await mkdir(bin);
  await mkdir(scratch);
  await writeFile(redactorPath, "export const redactSensitiveText = (value) => value;\n");
  await writeFile(
    path.join(bin, "node"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
    { mode: 0o755 },
  );
  await writeFile(fixturePath, JSON.stringify({ skillText: maintainedSkillText, ...options }));
  await writeFile(
    path.join(bin, "pnpm"),
    `#!${process.execPath}
const fs = require("node:fs");
const path = require("node:path");
const fixture = JSON.parse(fs.readFileSync(${JSON.stringify(fixturePath)}, "utf8"));
const args = process.argv.slice(2);
if (args[0] === "--silent") args.shift();
if (args[0] === "openclaw") args.shift();
fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(args) + "\\n");
const workspace = path.join(process.env.HOME, ".openclaw/workspace");
const slug = (args[2] || "").split("/").at(-1);
const skillDir = path.join(workspace, "skills", slug);
if (args[0] !== "skills") process.exit(64);
switch (args[1]) {
  case "search":
    console.log(JSON.stringify({ results: fixture.results }));
    break;
  case "install": {
    if (fixture.refusal) {
      console.error("ClawHub found security risks in gifgrep@1.0.1");
      console.error("Update cancelled; rerun with --acknowledge-clawhub-risk");
      process.exit(1);
    }
    const versionIndex = args.indexOf("--version");
    const version = versionIndex < 0 ? "9.9.9" : args[versionIndex + 1];
    fs.mkdirSync(path.join(skillDir, ".clawhub"), { recursive: true });
    fs.mkdirSync(path.join(workspace, ".clawhub"), { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), fixture.skillText);
    fs.writeFileSync(path.join(skillDir, ".clawhub/origin.json"), JSON.stringify({
      slug, registry: "https://clawhub.ai", ownerHandle: "steipete",
      installedVersion: version, ...fixture.origin,
    }));
    fs.writeFileSync(path.join(workspace, ".clawhub/lock.json"), JSON.stringify({
      skills: { [slug]: { version, ownerHandle: "steipete", ...fixture.lock } },
    }));
    break;
  }
  case "info":
    console.log(JSON.stringify({ skillKey: slug, baseDir: skillDir }));
    break;
  default: process.exit(64);
}
`,
    { mode: 0o755 },
  );
  const result = spawnSync(
    process.platform === "darwin" ? "/bin/bash" : "bash",
    ["scripts/e2e/lib/skills/clawhub-install-proof.sh"],
    {
      encoding: "utf8",
      timeout: 10_000,
      env: {
        PATH: `${bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        HOME: root,
        TMPDIR: scratch,
        OPENCLAW_E2E_REDACTOR_MODULE: redactorPath,
        ...options.overrides,
      },
    },
  );
  expect(result.error).toBeUndefined();
  expect(
    (await readdir(scratch)).filter((entry) => entry.startsWith("openclaw-skill-install")),
  ).toEqual([]);
  const calls = (await readFile(callsPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as string[]);
  return { ...result, calls };
}

async function listShellScripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const scripts: string[] = [];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scripts.push(...(await listShellScripts(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".sh")) {
      scripts.push(entryPath);
    }
  }

  return scripts;
}

async function extractClawhubSkillInstallVerifier(): Promise<string> {
  const script = await readFile("scripts/e2e/lib/skills/clawhub-install-proof.sh", "utf8");
  const marker =
    'run_node_module "$OPENCLAW_CONFIG_PATH" "$skill_dir" "$origin_json" "$lock_json" "$info_json" "$slug" "$maintained_fixture" <<\'NODE\'\n';
  const start = script.indexOf(marker);
  if (start === -1) {
    throw new Error("ClawHub skill install verifier heredoc was not found");
  }
  const verifierStart = start + marker.length;
  const verifierEnd = script.indexOf("\nNODE", verifierStart);
  if (verifierEnd === -1) {
    throw new Error("ClawHub skill install verifier heredoc was not terminated");
  }
  return script.slice(verifierStart, verifierEnd);
}

async function extractClawhubSkillInstallSelector(): Promise<string> {
  const script = await readFile("scripts/e2e/lib/skills/clawhub-install-proof.sh", "utf8");
  const marker =
    'run_node_module "$search_json" "$resolve_json" "$requested_slug" "$preferred_slug" "$maintained_fixture" <<\'NODE\'\n';
  const start = script.indexOf(marker);
  if (start === -1) {
    throw new Error("ClawHub skill install selector heredoc was not found");
  }
  const selectorStart = start + marker.length;
  const selectorEnd = script.indexOf("\nNODE", selectorStart);
  if (selectorEnd === -1) {
    throw new Error("ClawHub skill install selector heredoc was not terminated");
  }
  return script.slice(selectorStart, selectorEnd);
}

describe("e2e shell tempfile hygiene", () => {
  it("does not allocate FIFO paths with mktemp -u", async () => {
    const offenders: string[] = [];

    for (const scriptPath of await listShellScripts("scripts/e2e")) {
      const contents = await readFile(path.resolve(scriptPath), "utf8");
      if (contents.includes("mktemp -u")) {
        offenders.push(scriptPath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it.each([
    { name: "persistent failure", succeedsAfter: 0, exitCode: 7, calls: 2 },
    { name: "immediate success", succeedsAfter: 1, exitCode: 0, calls: 1 },
    { name: "success after a failed probe", succeedsAfter: 2, exitCode: 0, calls: 2 },
  ])("preserves config reload RPC status on $name", async (scenario) => {
    const tempRoot = tempDirs.make("openclaw-config-reload-status-");
    const script = await readFile("scripts/e2e/config-reload-source-docker.sh", "utf8");
    const rpcFunction = script.match(/^check_rpc_status\(\) \{[\s\S]*?^\}/m)?.[0];
    if (!rpcFunction) {
      throw new Error("Config reload RPC status function was not found");
    }
    const callsPath = path.join(tempRoot, "calls.txt");
    const result = spawnSync(
      process.platform === "darwin" ? "/bin/bash" : "bash",
      [
        "-c",
        `
set -euo pipefail
PORT=18789
TOKEN=synthetic-token
CONTAINER_NAME=synthetic-container
docker_e2e_docker_cmd() {
  "$BASH" -c "$PROBE_PRELUDE
$5"
}
${rpcFunction}
check_rpc_status "$OUTPUT_PATH"
`,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          ...process.env,
          OUTPUT_PATH: path.join(tempRoot, "rpc.log"),
          CALLS_PATH: callsPath,
          SUCCEEDS_AFTER: String(scenario.succeedsAfter),
          PROBE_PRELUDE: `
source() { :; }
openclaw_e2e_resolve_entrypoint() { printf '%s' synthetic-entry; }
calls=0
SECONDS=0
node() {
  calls=$((calls + 1))
  printf '%s' "$calls" > "$CALLS_PATH"
  if [ "$SUCCEEDS_AFTER" -gt 0 ] && [ "$calls" -ge "$SUCCEEDS_AFTER" ]; then
    return 0
  fi
  printf '%s\\n' 'synthetic RPC failure' >&2
  return 7
}
# Advance the real loop's clock without waiting for its 120-second deadline.
sleep() { SECONDS=$((SECONDS + 61)); }
`,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(scenario.exitCode);
    expect(await readFile(callsPath, "utf8")).toBe(String(scenario.calls));
    if (scenario.exitCode !== 0) {
      expect(result.stderr).toContain("synthetic RPC failure");
    }
  });

  it("preserves wizard exit status when reporting failures", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-status-test-"));
    const fixturePath = path.join(tempRoot, "wizard-status.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
OPENCLAW_ENTRY=node
openclaw_test_state_create() { :; }
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_run_script_with_pty() {
  local _command="$1"
  local log_path="$2"
  printf 'fake wizard log\\n' >"$log_path"
  exit 7
}

send_noop() { :; }

run_wizard_cmd failing-wizard fake-state "node fake-wizard" send_noop false
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(7);
      expect(output).toContain("Wizard exited with status 7");
      expect(output).toContain("fake wizard log");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("delivers wizard input and EOF without retaining an inherited writer", async () => {
    const tempRoot = tempDirs.make("openclaw-onboard-fifo-eof-");
    const fixturePath = path.join(tempRoot, "wizard-eof.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail
export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
OPENCLAW_ENTRY=node
openclaw_test_state_create() { :; }
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_run_script_with_pty() { cat >"$2"; }
send_and_close() {
  printf 'wizard input\\n' >&3
  exec 3>&-
}
run_wizard_cmd eof-wizard fake-state cat send_and_close false
printf 'recorded input:'
cat "$WIZARD_LOG_PATH"
test -z "$(find "$ONBOARD_TMP_DIR" -name '*.fifo.*')"
cleanup_onboard_artifacts
test ! -e "$ONBOARD_TMP_DIR"
`,
    );

    const result = spawnSync("bash", [fixturePath], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("recorded input:wizard input\n");
  });

  it("does not wait for a skills prompt after the ready state renders", async () => {
    const tempRoot = tempDirs.make("openclaw-onboard-skills-ready-");
    const fixturePath = path.join(tempRoot, "skills-ready.sh");
    const sentPath = path.join(tempRoot, "sent.txt");
    const wizardLogPath = path.join(tempRoot, "skills.log");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

sleep() { :; }
WIZARD_LOG_PATH=${JSON.stringify(wizardLogPath)}
printf 'Skills status\\nAll skills ready\\n' >"$WIZARD_LOG_PATH"
exec 3>${JSON.stringify(sentPath)}
send_skills_flow
exec 3>&-
test ! -s ${JSON.stringify(sentPath)}
`,
    );

    const result = spawnSync("bash", [fixturePath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Timeout waiting");
  });

  it("checks local onboarding logs for systemd noise", async () => {
    const contents = await readFile("scripts/e2e/lib/onboard/scenario.sh", "utf8");

    expect(contents).toContain(
      'ONBOARD_TMP_DIR="$(mktemp -d "$ONBOARD_TMP_ROOT/openclaw-onboard.XXXXXX")"',
    );
    expect(contents).toContain('OPENCLAW_E2E_LOG_DIR="$ONBOARD_TMP_DIR/logs"');
    expect(contents).toContain('GATEWAY_LOG_PATH="$ONBOARD_TMP_DIR/gateway-e2e.log"');
    expect(contents).not.toContain("/tmp/gateway-e2e.log");
    expect(contents).toContain('validate_local_basic_log "$OPENCLAW_E2E_LAST_LOG_PATH"');
    expect(contents).not.toContain(
      "validate_local_basic_log /tmp/openclaw-onboard-local-basic.log",
    );
    expect(contents).toContain(
      'openclaw_e2e_assert_log_not_contains "$log_path" "systemctl --user unavailable"',
    );
  });

  it("probes onboarding gateway readiness through TCP", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-gateway-log-"));
    const fixturePath = path.join(tempRoot, "gateway-log.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_probe_tcp() { return 0; }
sleep 30 &
GATEWAY_PID="$!"
printf 'listening on ws://127.0.0.1:18789\\n' >"$GATEWAY_LOG_PATH"
wait_for_gateway
case "$GATEWAY_LOG_PATH" in
  "$ONBOARD_TMP_DIR"/*) ;;
  *) echo "gateway log escaped scratch root: $GATEWAY_LOG_PATH" >&2; exit 1 ;;
esac
cleanup_onboard_artifacts
test ! -e "$ONBOARD_TMP_DIR"
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects onboarding gateway readiness when the TCP probe fails", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-gateway-tcp-"));
    const fixturePath = path.join(tempRoot, "gateway-tcp.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
export OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=2
export OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S=0.1
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_probe_tcp() { return 1; }
sleep 30 &
GATEWAY_PID="$!"
printf 'listening on ws://127.0.0.1:18789\\n' >"$GATEWAY_LOG_PATH"
if wait_for_gateway; then
  echo "gateway readiness passed without TCP reachability" >&2
  cleanup_onboard_artifacts
  exit 1
fi
cleanup_onboard_artifacts
test ! -e "$ONBOARD_TMP_DIR"
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Gateway failed to start");
      expect(result.stdout).toContain("TCP probe never succeeded");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects invalid onboarding gateway wait attempts before probing", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-gateway-attempts-"));
    const fixturePath = path.join(tempRoot, "gateway-attempts.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
export OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=2x
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_probe_tcp() {
  echo "probe should not run" >&2
  return 1
}
set +e
wait_for_gateway
status="$?"
set -e
cleanup_onboard_artifacts
exit "$status"
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS: 2x");
      expect(result.stderr).not.toContain("probe should not run");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("removes fallback ClawHub skill install HOME on failure", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-clawhub-home-test-"));
    const fakeBin = path.join(tempRoot, "bin");
    const scratchRoot = path.join(tempRoot, "scratch");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(scratchRoot, { recursive: true });
    await writeFile(
      path.join(fakeBin, "pnpm"),
      `#!/usr/bin/env bash
exit 42
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", ["scripts/e2e/lib/skills/clawhub-install-proof.sh"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CURRENT_PACKAGE_TGZ: "",
          OPENCLAW_TEST_STATE_SCRIPT_B64: "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: scratchRoot,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(42);
      const scratchEntries = await readdir(scratchRoot);
      expect(
        scratchEntries.filter((entry) => entry.startsWith("openclaw-skill-install-home.")),
      ).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("selects a non-suspicious ClawHub search result without weakening explicit requests", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-clawhub-select-test-"));
    const searchPath = path.join(tempRoot, "search.json");
    const resolvePath = path.join(tempRoot, "resolved.json");
    const selector = await extractClawhubSkillInstallSelector();
    await writeFile(
      searchPath,
      `${JSON.stringify({
        results: [
          {
            installRef: "@owner/risky",
            native: { skill: { isSuspicious: true } },
            slug: "preferred",
            trust: { clawHubVerdict: "suspicious" },
          },
          {
            installRef: "@owner/safe",
            native: { skill: { isSuspicious: false } },
            slug: "homeassistant-safe",
            trust: { clawHubVerdict: null, installability: "installable" },
          },
          {
            installRef: "@owner/fallback-two",
            slug: "fallback-two",
          },
          {
            installRef: "@owner/fallback-three",
            slug: "fallback-three",
          },
          {
            installRef: "@owner/fallback-four",
            slug: "fallback-four",
          },
        ],
      })}\n`,
    );

    try {
      const defaultResult = spawnSync(
        process.execPath,
        ["--input-type=module", "-", searchPath, resolvePath, "", "preferred"],
        { encoding: "utf8", input: selector },
      );
      expect(defaultResult.status, defaultResult.stderr).toBe(0);
      expect(JSON.parse(await readFile(resolvePath, "utf8"))).toMatchObject({
        candidates: [
          {
            installRef: "@owner/safe",
            slug: "homeassistant-safe",
          },
          {
            installRef: "@owner/fallback-two",
            slug: "fallback-two",
          },
          {
            installRef: "@owner/fallback-three",
            slug: "fallback-three",
          },
          {
            installRef: "@owner/fallback-four",
            slug: "fallback-four",
          },
        ],
      });

      const explicitResult = spawnSync(
        process.execPath,
        ["--input-type=module", "-", searchPath, resolvePath, "preferred", "preferred"],
        { encoding: "utf8", input: selector },
      );
      expect(explicitResult.status, explicitResult.stderr).toBe(0);
      expect(JSON.parse(await readFile(resolvePath, "utf8"))).toMatchObject({
        candidates: [
          {
            installRef: "@owner/risky",
            slug: "preferred",
          },
        ],
      });
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("falls through a search candidate rejected by live ClawHub security", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-clawhub-live-risk-test-"));
    const fakeBin = path.join(tempRoot, "bin");
    const scratchRoot = path.join(tempRoot, "scratch");
    const attemptsPath = path.join(tempRoot, "attempts.txt");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(scratchRoot, { recursive: true });
    await writeFile(
      path.join(fakeBin, "pnpm"),
      `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = --silent ]; then shift; fi
if [ "\${1:-}" = openclaw ]; then shift; fi
case "\${1:-} \${2:-}" in
  "skills search")
    printf '%s\n' '{"results":[{"slug":"risky","installRef":"risky"},{"slug":"safe","installRef":"safe"}]}'
    ;;
  "skills install")
    ref="\${3:-}"
    printf '%s\n' "$ref" >>${JSON.stringify(attemptsPath)}
    if [ "$ref" = risky ]; then
      if [ "\${FAKE_RISK_MODE:-blocked}" = unrelated ]; then
        printf '%s\n' 'network connection reset' >&2
        exit 1
      fi
      if [ "\${FAKE_RISK_MODE:-current}" = frozen ]; then
        printf '%s\n' '╭─ ClawHub Security Audit ─╮' >&2
        printf '%s\n' '│ Outcome: Blocked        │' >&2
      else
        printf '%s\n' 'ClawHub found security risks in risky@1.0.0' >&2
        printf '%s\n' 'Update cancelled; rerun with --acknowledge-clawhub-risk' >&2
      fi
      exit 1
    fi
    skill_dir="$HOME/.openclaw/workspace/skills/safe"
    mkdir -p "$skill_dir/.clawhub" "$HOME/.openclaw/workspace/.clawhub"
    printf '%s\n' 'name: Safe' >"$skill_dir/SKILL.md"
    printf '%s\n' '{"slug":"safe","registry":"https://clawhub.ai","installedVersion":"1.0.0"}' >"$skill_dir/.clawhub/origin.json"
    printf '%s\n' '{"skills":{"safe":{"version":"1.0.0"}}}' >"$HOME/.openclaw/workspace/.clawhub/lock.json"
    ;;
  "skills info")
    printf '{"skillKey":"safe","baseDir":"%s"}\n' "$HOME/.openclaw/workspace/skills/safe"
    ;;
  *) exit 64 ;;
esac
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", ["scripts/e2e/lib/skills/clawhub-install-proof.sh"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CURRENT_PACKAGE_TGZ: "",
          OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG: "risky",
          OPENCLAW_TEST_STATE_SCRIPT_B64: "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: scratchRoot,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        "Skipping live ClawHub skill with current security findings: risky",
      );
      expect(result.stdout).toContain("E2E_OK installed=safe version=1.0.0");
      expect((await readFile(attemptsPath, "utf8")).trim().split("\n")).toEqual(["risky", "safe"]);

      await rm(attemptsPath, { force: true });
      const frozenResult = spawnSync("bash", ["scripts/e2e/lib/skills/clawhub-install-proof.sh"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_RISK_MODE: "frozen",
          OPENCLAW_CURRENT_PACKAGE_TGZ: "",
          OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG: "risky",
          OPENCLAW_TEST_STATE_SCRIPT_B64: "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: scratchRoot,
        },
      });
      expect(frozenResult.status, `${frozenResult.stdout}\n${frozenResult.stderr}`).toBe(0);
      expect((await readFile(attemptsPath, "utf8")).trim().split("\n")).toEqual(["risky", "safe"]);

      await rm(attemptsPath, { force: true });
      const explicitResult = spawnSync(
        "bash",
        ["scripts/e2e/lib/skills/clawhub-install-proof.sh"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_CURRENT_PACKAGE_TGZ: "",
            OPENCLAW_SKILL_INSTALL_E2E_SLUG: "risky",
            OPENCLAW_TEST_STATE_SCRIPT_B64: "",
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            TMPDIR: scratchRoot,
          },
        },
      );
      expect(explicitResult.status).not.toBe(0);
      expect((await readFile(attemptsPath, "utf8")).trim()).toBe("risky");

      await rm(attemptsPath, { force: true });
      const unrelatedResult = spawnSync(
        "bash",
        ["scripts/e2e/lib/skills/clawhub-install-proof.sh"],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_RISK_MODE: "unrelated",
            OPENCLAW_CURRENT_PACKAGE_TGZ: "",
            OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG: "risky",
            OPENCLAW_TEST_STATE_SCRIPT_B64: "",
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
            TMPDIR: scratchRoot,
          },
        },
      );
      expect(unrelatedResult.status).not.toBe(0);
      expect((await readFile(attemptsPath, "utf8")).trim()).toBe("risky");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it.each([
    { shape: "raw", row: maintainedRawRow },
    { shape: "mapped", row: maintainedMappedRow },
    { shape: "consistent hybrid", row: { ...maintainedRawRow, ...maintainedMappedRow } },
  ])("pins the maintained $shape ClawHub fixture", async ({ row }) => {
    const result = await runClawhubInstallProof({
      results: [
        {
          ...maintainedMappedRow,
          ownerHandle: "another-owner",
          installRef: "@another-owner/gifgrep",
        },
        {
          ...maintainedRawRow,
          source: "skills.sh",
          install: { kind: "github", reference: "elsewhere/gifgrep" },
        },
        row,
      ],
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      ["skills", "search", "gifgrep", "--limit", "8", "--json"],
      ["skills", "install", "@steipete/gifgrep", "--version", "1.0.1", "--force"],
      ["skills", "info", "gifgrep", "--json"],
    ]);
    expect(result.stdout).toContain("E2E_OK installed=gifgrep version=1.0.1");
  });

  it("keeps the maintained fixture when all overrides are explicitly empty", async () => {
    const result = await runClawhubInstallProof({
      results: [maintainedRawRow],
      overrides: {
        OPENCLAW_SKILL_INSTALL_E2E_QUERY: "",
        OPENCLAW_SKILL_INSTALL_E2E_SLUG: "",
        OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG: "",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls[1]).toEqual([
      "skills",
      "install",
      "@steipete/gifgrep",
      "--version",
      "1.0.1",
      "--force",
    ]);
  });

  it.each([
    ["wrong owner", { ...maintainedMappedRow, ownerHandle: "other" }],
    ["wrong ref", { ...maintainedMappedRow, installRef: "@other/gifgrep" }],
    ["null ref", { ...maintainedRawRow, installRef: null }],
    ["empty ref", { ...maintainedRawRow, installRef: "" }],
    ["external source", { ...maintainedRawRow, source: "skills.sh" }],
    [
      "external kind",
      { ...maintainedRawRow, install: { kind: "github", reference: "steipete/gifgrep" } },
    ],
    [
      "wrong raw ref",
      { ...maintainedRawRow, install: { kind: "clawhub", reference: "other/gifgrep" } },
    ],
    ["missing install", { ...maintainedMappedRow, source: "clawhub" }],
    ["missing source", { ...maintainedMappedRow, install: maintainedRawRow.install }],
    ["null source", { ...maintainedMappedRow, source: null }],
    ["empty source", { ...maintainedMappedRow, source: "" }],
    ["null install", { ...maintainedRawRow, install: null }],
    ["partial install", { ...maintainedRawRow, install: { kind: "clawhub" } }],
    ["contradictory hybrid", { ...maintainedRawRow, installRef: "@other/gifgrep" }],
  ] as const)("rejects maintained fixture search identity: %s", async (_name, row) => {
    const result = await runClawhubInstallProof({ results: [row] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Maintained ClawHub fixture");
    expect(result.calls).toEqual([["skills", "search", "gifgrep", "--limit", "8", "--json"]]);
  });

  it.each([
    {
      marker: "mapped trust verdict",
      row: { ...maintainedMappedRow, trust: { clawHubVerdict: "suspicious" } },
    },
    {
      marker: "native suspicious flag",
      row: { ...maintainedRawRow, native: { skill: { isSuspicious: true } } },
    },
  ])("rejects maintained fixture risk before install: $marker", async ({ row }) => {
    const result = await runClawhubInstallProof({ results: [row] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Maintained ClawHub fixture");
    expect(result.calls).toEqual([["skills", "search", "gifgrep", "--limit", "8", "--json"]]);
  });

  it.each([
    { name: "origin owner", origin: { ownerHandle: "other" } },
    { name: "lock owner", lock: { ownerHandle: "other" } },
    {
      name: "agreed wrong version",
      origin: { installedVersion: "9.9.9" },
      lock: { version: "9.9.9" },
    },
    { name: "changed source", skillText: "name: gifgrep\nchanged: true\n" },
    { name: "security refusal", refusal: true },
  ])("rejects maintained fixture $name without an alternate install", async (fault) => {
    const result = await runClawhubInstallProof({ results: [maintainedRawRow], ...fault });
    expect(result.status).toBe(1);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("E2E_OK");
    expect(result.calls.filter((args) => args[1] === "install")).toEqual([
      ["skills", "install", "@steipete/gifgrep", "--version", "1.0.1", "--force"],
    ]);
    expect(result.stdout).not.toContain("Skipping live ClawHub skill");
  });

  it.each([
    "OPENCLAW_SKILL_INSTALL_E2E_QUERY",
    "OPENCLAW_SKILL_INSTALL_E2E_SLUG",
    "OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG",
  ])("preserves custom behavior for %s alone", async (key) => {
    const result = await runClawhubInstallProof({
      results: [{ slug: "custom", installRef: "@another-owner/custom" }],
      overrides: { [key]: "custom" },
      origin: { ownerHandle: "another-owner" },
      lock: { ownerHandle: "another-owner" },
      skillText: "name: Custom\n",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toEqual([
      [
        "skills",
        "search",
        key.endsWith("_QUERY") ? "custom" : "homeassistant",
        "--limit",
        "8",
        "--json",
      ],
      ["skills", "install", "@another-owner/custom", "--force"],
      ["skills", "info", "custom", "--json"],
    ]);
  });

  it.each(["", "custom"])("forwards raw Docker skill overrides: %j", (value) => {
    const result = spawnSync(
      process.platform === "darwin" ? "/bin/bash" : "bash",
      [
        "-c",
        `
set -euo pipefail
source() { :; }
docker_e2e_resolve_image() { printf '%s' fixture-image; }
docker_e2e_cleanup_package_tgz() { :; }
docker_e2e_prepare_package_tgz() { printf '%s' fixture-package.tgz; }
docker_e2e_test_state_shell_b64() { printf '%s' fixture-state; }
docker_e2e_package_mount_args() { DOCKER_E2E_PACKAGE_ARGS=(-v fixture-package.tgz:/tmp/openclaw.tgz:ro); }
docker_e2e_build_or_reuse() { :; }
run_logged_print() { shift; "$@"; }
docker_e2e_run_with_harness() { printf '%s\\n' "$@"; }
. scripts/e2e/skill-install-docker.sh
`,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: {
          PATH: "/usr/bin:/bin",
          OPENCLAW_SKILL_INSTALL_E2E_QUERY: value,
          OPENCLAW_SKILL_INSTALL_E2E_SLUG: value,
          OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG: value,
        },
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    const args = result.stdout.trim().split("\n");
    for (const key of ["QUERY", "SLUG", "PREFERRED_SLUG"]) {
      expect(args).toContain(`OPENCLAW_SKILL_INSTALL_E2E_${key}=${value}`);
    }
    expect(args.slice(-3)).toEqual([
      "fixture-image",
      "bash",
      "scripts/e2e/lib/skills/clawhub-install-proof.sh",
    ]);
  });

  it("rejects ClawHub skill info paths that only share a resolved prefix", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-clawhub-info-path-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const slug = "demo";
    const skillDir = path.join(workspaceDir, "skills", slug);
    const escapedInfoPath = path.join(workspaceDir, "skills", `${slug}-escape`, "SKILL.md");
    const configPath = path.join(tempRoot, "openclaw.json");
    const originPath = path.join(skillDir, ".clawhub", "origin.json");
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const infoPath = path.join(tempRoot, "info.json");

    try {
      await mkdir(path.dirname(originPath), { recursive: true });
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: Demo\n---\n`);
      await writeFile(
        configPath,
        `${JSON.stringify({ skills: { install: { allowUploadedArchives: false } } })}\n`,
      );
      await writeFile(
        originPath,
        `${JSON.stringify({
          installedVersion: "1.0.0",
          registry: "https://clawhub.ai",
          slug,
        })}\n`,
      );
      await writeFile(
        lockPath,
        `${JSON.stringify({ skills: { [slug]: { version: "1.0.0" } } })}\n`,
      );
      await writeFile(
        infoPath,
        `${JSON.stringify({ filePath: escapedInfoPath, skillKey: "wrong-skill" })}\n`,
      );

      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-", configPath, skillDir, originPath, lockPath, infoPath, slug],
        {
          encoding: "utf8",
          input: await extractClawhubSkillInstallVerifier(),
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("skills info did not report installed skill demo");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
