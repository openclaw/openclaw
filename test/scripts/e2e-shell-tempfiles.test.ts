import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function runShell(
  body: string,
  options: Omit<SpawnSyncOptionsWithStringEncoding, "encoding"> = {},
) {
  return spawnSync(process.platform === "darwin" ? "/bin/bash" : "bash", ["-c", body], {
    encoding: "utf8",
    ...options,
  });
}

function runOnboard(body: string, setup = "", timeout?: number) {
  const root = tempDirs.make("openclaw-onboard-");
  return runShell(
    `
set -euo pipefail
export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(root)}
OPENCLAW_ENTRY=node
${setup}
source scripts/e2e/lib/onboard/scenario.sh
${body}`,
    { cwd: process.cwd(), timeout },
  );
}

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
const searchArgs = (query = "gifgrep") => ["skills", "search", query, "--limit", "8", "--json"];
const installArgs = ["skills", "install", "@steipete/gifgrep", "--version", "1.0.1", "--force"];
const candidate = (slug: string, installRef: string) => ({ slug, installRef });
const writeJson = (file: string, value: unknown) => writeFile(file, `${JSON.stringify(value)}\n`);
const writeExecutable = (file: string, contents: string) =>
  writeFile(file, contents, { mode: 0o755 });

const maintainedMappedRow = {
  slug: "gifgrep",
  ownerHandle: "steipete",
  installRef: "@steipete/gifgrep",
};

async function installFixture(prefix: string) {
  const root = tempDirs.make(prefix);
  const bin = path.join(root, "bin");
  const scratch = path.join(root, "scratch");
  await Promise.all([mkdir(bin), mkdir(scratch)]);
  return { root, bin, scratch };
}

async function runClawhubInstallProof(options: {
  results: Record<string, unknown>[];
  overrides?: Record<string, string>;
  origin?: Record<string, unknown>;
  lock?: Record<string, unknown>;
  skillText?: string;
  refusal?: boolean | "frozen" | "unrelated";
  rejectedSlug?: string;
}) {
  const { root, bin, scratch } = await installFixture("openclaw-clawhub-maintained-");
  const callsPath = path.join(root, "calls.jsonl");
  const fixturePath = path.join(root, "fixture.json");
  const redactorPath = path.join(root, "redactor.mjs");
  await writeFile(redactorPath, "export const redactSensitiveText = (value) => value;\n");
  await writeExecutable(
    path.join(bin, "node"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} "$@"\n`,
  );
  await writeFile(fixturePath, JSON.stringify({ skillText: maintainedSkillText, ...options }));
  await writeExecutable(
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
    if (fixture.refusal && (!fixture.rejectedSlug || fixture.rejectedSlug === slug)) {
      if (fixture.refusal === "unrelated") {
        console.error("network connection reset");
      } else if (fixture.refusal === "frozen") {
        console.error("╭─ ClawHub Security Audit ─╮");
        console.error("│ Outcome: Blocked        │");
      } else {
        console.error("ClawHub found security risks in " + slug + "@1.0.1");
        console.error("Update cancelled; rerun with --acknowledge-clawhub-risk");
      }
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

async function extractClawhubModule(kind: "verifier" | "selector"): Promise<string> {
  const script = await readFile("scripts/e2e/lib/skills/clawhub-install-proof.sh", "utf8");
  const args =
    kind === "verifier"
      ? '"$OPENCLAW_CONFIG_PATH" "$skill_dir" "$origin_json" "$lock_json" "$info_json" "$slug" "$maintained_fixture"'
      : '"$search_json" "$resolve_json" "$requested_slug" "$preferred_slug" "$maintained_fixture"';
  const marker = `run_node_module ${args} <<'NODE'\n`;
  const start = script.indexOf(marker);
  const end = script.indexOf("\nNODE", start + marker.length);
  if (start === -1 || end === -1) {
    throw new Error(`ClawHub skill install ${kind} heredoc was not found or terminated`);
  }
  return script.slice(start + marker.length, end);
}

async function runClawhubModule(kind: "verifier" | "selector", ...args: string[]) {
  return spawnSync(process.execPath, ["--input-type=module", "-", ...args], {
    encoding: "utf8",
    input: await extractClawhubModule(kind),
  });
}

function runInstall(bin: string, scratch: string) {
  return spawnSync("bash", ["scripts/e2e/lib/skills/clawhub-install-proof.sh"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CURRENT_PACKAGE_TGZ: "",
      OPENCLAW_TEST_STATE_SCRIPT_B64: "",
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      TMPDIR: scratch,
    },
  });
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
    const result = runShell(
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
      {
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

  it("preserves wizard exit status when reporting failures", () => {
    const result = runOnboard(
      `
openclaw_e2e_run_script_with_pty() {
  local _command="$1"
  local log_path="$2"
  printf 'fake wizard log\\n' >"$log_path"
  exit 7
}

send_noop() { :; }

run_wizard_cmd failing-wizard fake-state "node fake-wizard" send_noop false
`,
      "openclaw_test_state_create() { :; }",
    );

    const output = `${result.stdout}\n${result.stderr}`;

    expect(result.status).toBe(7);
    expect(output).toContain("Wizard exited with status 7");
    expect(output).toContain("fake wizard log");
  });

  it("delivers wizard input and EOF without retaining an inherited writer", () => {
    const result = runOnboard(
      `
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
      "openclaw_test_state_create() { :; }",
      10_000,
    );

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain("recorded input:wizard input\n");
  });

  it("does not wait for a skills prompt after the ready state renders", () => {
    const result = runOnboard(
      `
sleep() { :; }
WIZARD_LOG_PATH="$OPENCLAW_ONBOARD_E2E_TMPDIR/skills.log"
printf 'Skills status\\nAll skills ready\\n' >"$WIZARD_LOG_PATH"
exec 3>"$OPENCLAW_ONBOARD_E2E_TMPDIR/sent.txt"
send_skills_flow
exec 3>&-
test ! -s "$OPENCLAW_ONBOARD_E2E_TMPDIR/sent.txt"
`,
    );

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Timeout waiting");
  });

  it("checks local onboarding logs for systemd noise", async () => {
    const contents = await readFile("scripts/e2e/lib/onboard/scenario.sh", "utf8");

    for (const text of [
      'ONBOARD_TMP_DIR="$(mktemp -d "$ONBOARD_TMP_ROOT/openclaw-onboard.XXXXXX")"',
      'OPENCLAW_E2E_LOG_DIR="$ONBOARD_TMP_DIR/logs"',
      'GATEWAY_LOG_PATH="$ONBOARD_TMP_DIR/gateway-e2e.log"',
      'validate_local_basic_log "$OPENCLAW_E2E_LAST_LOG_PATH"',
      'openclaw_e2e_assert_log_not_contains "$log_path" "systemctl --user unavailable"',
    ]) {
      expect(contents).toContain(text);
    }
    for (const text of [
      "/tmp/gateway-e2e.log",
      "validate_local_basic_log /tmp/openclaw-onboard-local-basic.log",
    ]) {
      expect(contents).not.toContain(text);
    }
  });

  it.each([true, false])(
    "requires onboarding gateway TCP readiness (reachable=%s)",
    (reachable) => {
      const result = runOnboard(
        `
openclaw_e2e_probe_tcp() { return ${reachable ? 0 : 1}; }
sleep 30 &
GATEWAY_PID="$!"
printf 'listening on ws://127.0.0.1:18789\\n' >"$GATEWAY_LOG_PATH"
if wait_for_gateway; then
  test ${reachable ? 0 : 1} -eq 0
else
  test ${reachable ? 0 : 1} -eq 1
fi
case "$GATEWAY_LOG_PATH" in
  "$ONBOARD_TMP_DIR"/*) ;;
  *) echo "gateway log escaped scratch root: $GATEWAY_LOG_PATH" >&2; exit 1 ;;
esac
cleanup_onboard_artifacts
test ! -e "$ONBOARD_TMP_DIR"
`,
        reachable
          ? ""
          : "export OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=2\nexport OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S=0.1",
      );
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      if (!reachable) {
        expect(result.stdout).toContain("Gateway failed to start");
        expect(result.stdout).toContain("TCP probe never succeeded");
      }
    },
  );

  it("rejects invalid onboarding gateway wait attempts before probing", () => {
    const result = runOnboard(
      `
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
      "export OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=2x",
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS: 2x");
    expect(result.stderr).not.toContain("probe should not run");
  });

  it("removes fallback ClawHub skill install HOME on failure", async () => {
    const { bin: fakeBin, scratch: scratchRoot } = await installFixture(
      "openclaw-clawhub-home-test-",
    );
    await writeExecutable(path.join(fakeBin, "pnpm"), "#!/usr/bin/env bash\nexit 42\n");

    const result = runInstall(fakeBin, scratchRoot);

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(42);
    const scratchEntries = await readdir(scratchRoot);
    expect(
      scratchEntries.filter((entry) => entry.startsWith("openclaw-skill-install-home.")),
    ).toEqual([]);
  });

  it("selects a non-suspicious ClawHub search result without weakening explicit requests", async () => {
    const tempRoot = tempDirs.make("openclaw-clawhub-select-test-");
    const searchPath = path.join(tempRoot, "search.json");
    const resolvePath = path.join(tempRoot, "resolved.json");
    await writeJson(searchPath, {
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
        candidate("fallback-two", "@owner/fallback-two"),
        candidate("fallback-three", "@owner/fallback-three"),
        candidate("fallback-four", "@owner/fallback-four"),
      ],
    });

    const defaultResult = await runClawhubModule(
      "selector",
      searchPath,
      resolvePath,
      "",
      "preferred",
    );
    expect(defaultResult.status, defaultResult.stderr).toBe(0);
    expect(JSON.parse(await readFile(resolvePath, "utf8"))).toMatchObject({
      candidates: [
        candidate("homeassistant-safe", "@owner/safe"),
        candidate("fallback-two", "@owner/fallback-two"),
        candidate("fallback-three", "@owner/fallback-three"),
        candidate("fallback-four", "@owner/fallback-four"),
      ],
    });

    const explicitResult = await runClawhubModule(
      "selector",
      searchPath,
      resolvePath,
      "preferred",
      "preferred",
    );
    expect(explicitResult.status, explicitResult.stderr).toBe(0);
    expect(JSON.parse(await readFile(resolvePath, "utf8"))).toMatchObject({
      candidates: [candidate("preferred", "@owner/risky")],
    });
  });

  it("falls through a search candidate rejected by live ClawHub security", async () => {
    const runRisk = (refusal: true | "frozen" | "unrelated", explicit = false) =>
      runClawhubInstallProof({
        results: [candidate("risky", "risky"), candidate("safe", "safe")],
        overrides: {
          OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG: "risky",
          ...(explicit ? { OPENCLAW_SKILL_INSTALL_E2E_SLUG: "risky" } : {}),
        },
        origin: { installedVersion: "1.0.0" },
        lock: { version: "1.0.0" },
        skillText: "name: Safe\n",
        refusal,
        rejectedSlug: "risky",
      });
    const attempts = (calls: string[][]) =>
      calls.filter((args) => args[1] === "install").map((args) => args[2]);
    for (const mode of [true, "frozen"] as const) {
      const result = await runRisk(mode);
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain(
        "Skipping live ClawHub skill with current security findings: risky",
      );
      expect(result.stdout).toContain("E2E_OK installed=safe version=1.0.0");
      expect(attempts(result.calls)).toEqual(["risky", "safe"]);
    }
    const explicitResult = await runRisk(true, true);
    expect(explicitResult.status).not.toBe(0);
    expect(attempts(explicitResult.calls)).toEqual(["risky"]);

    const unrelatedResult = await runRisk("unrelated");
    expect(unrelatedResult.status).not.toBe(0);
    expect(attempts(unrelatedResult.calls)).toEqual(["risky"]);
  });

  it.each([
    { shape: "raw", row: maintainedRawRow },
    { shape: "mapped", row: maintainedMappedRow },
    { shape: "consistent hybrid", row: { ...maintainedRawRow, ...maintainedMappedRow } },
  ])("pins the maintained $shape ClawHub fixture", async ({ row }) => {
    const result = await runClawhubInstallProof({
      overrides:
        row === maintainedRawRow
          ? {
              OPENCLAW_SKILL_INSTALL_E2E_QUERY: "",
              OPENCLAW_SKILL_INSTALL_E2E_SLUG: "",
              OPENCLAW_SKILL_INSTALL_E2E_PREFERRED_SLUG: "",
            }
          : {},
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
      searchArgs(),
      installArgs,
      ["skills", "info", "gifgrep", "--json"],
    ]);
    expect(result.stdout).toContain("E2E_OK installed=gifgrep version=1.0.1");
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
    ["mapped trust verdict", { ...maintainedMappedRow, trust: { clawHubVerdict: "suspicious" } }],
    ["native suspicious flag", { ...maintainedRawRow, native: { skill: { isSuspicious: true } } }],
  ] as const)("rejects maintained fixture search identity: %s", async (_name, row) => {
    const result = await runClawhubInstallProof({ results: [row] });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Maintained ClawHub fixture");
    expect(result.calls).toEqual([searchArgs()]);
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
    expect(result.calls.filter((args) => args[1] === "install")).toEqual([installArgs]);
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
      searchArgs(key.endsWith("_QUERY") ? "custom" : "homeassistant"),
      ["skills", "install", "@another-owner/custom", "--force"],
      ["skills", "info", "custom", "--json"],
    ]);
  });

  it.each(["", "custom"])("forwards raw Docker skill overrides: %j", (value) => {
    const result = runShell(
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
      {
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
    const tempRoot = tempDirs.make("openclaw-clawhub-info-path-");
    const workspaceDir = path.join(tempRoot, "workspace");
    const slug = "demo";
    const skillDir = path.join(workspaceDir, "skills", slug);
    const escapedInfoPath = path.join(workspaceDir, "skills", `${slug}-escape`, "SKILL.md");
    const configPath = path.join(tempRoot, "openclaw.json");
    const originPath = path.join(skillDir, ".clawhub", "origin.json");
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const infoPath = path.join(tempRoot, "info.json");

    await mkdir(path.dirname(originPath), { recursive: true });
    await mkdir(path.dirname(lockPath), { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: Demo\n---\n`);
    await writeJson(configPath, { skills: { install: { allowUploadedArchives: false } } });
    await writeJson(originPath, {
      installedVersion: "1.0.0",
      registry: "https://clawhub.ai",
      slug,
    });
    await writeJson(lockPath, { skills: { [slug]: { version: "1.0.0" } } });
    await writeJson(infoPath, { filePath: escapedInfoPath, skillKey: "wrong-skill" });

    const result = await runClawhubModule(
      "verifier",
      configPath,
      skillDir,
      originPath,
      lockPath,
      infoPath,
      slug,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("skills info did not report installed skill demo");
  });
});
