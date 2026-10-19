import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/openclaw-performance-crabbox.sh");
const CONFIG = ".github/crabbox/openclaw-performance-untrusted.yaml";
const SCHEMA = ".github/crabbox/openclaw-performance-evidence.schema.json";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const scriptSource = readFileSync(SCRIPT, "utf8");
const definitions = scriptSource.slice(0, scriptSource.lastIndexOf('\ncase "${1:-}" in'));

function shell(code: string, env: NodeJS.ProcessEnv, args: string[] = [], timeout?: number) {
  return spawnSync("/bin/bash", ["-euo", "pipefail", "-c", `${definitions}\n${code}`, ...args], {
    env,
    encoding: "utf8",
    timeout,
    maxBuffer: timeout === undefined ? undefined : 256 * 1024,
  });
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown) {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function readText(root: string, path: string) {
  return readFileSync(join(root, path), "utf8");
}

function linesIfPresent(file: string) {
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = tempDirs.make("openclaw-performance-crabbox-");
  const artifact = ".artifacts/kova/reports/mock-provider/report.json";
  const artifactPath = join(root, artifact);
  const payload = join(root, "payload.tar.gz");
  const evidence = join(root, "remote-evidence.json");
  const timing = join(root, "timing.json");
  const output = join(root, ".artifacts/performance-crabbox/evidence/mock-provider.json");
  const contents = Buffer.from('{"status":"ok"}\n');
  mkdirSync(join(root, ".artifacts/kova/reports/mock-provider"), { recursive: true });
  writeFileSync(artifactPath, contents);
  execFileSync("tar", ["-czf", payload, "-C", root, artifact]);
  writeJson(evidence, {
    schemaVersion: 1,
    lane: "mock-provider",
    testedRef: "refs/pull/1/head",
    openclawSha: "a".repeat(40),
    kovaSha: "b".repeat(40),
    workflow: { sha: "c".repeat(40), runId: "123", runAttempt: "1" },
    crabbox: {
      commit: "8ba71f913bbe57285ae29af45ef0d8ec6712477d",
      version: "0.46.0+8ba71f913bbe",
    },
    command: {
      name: "mock-provider",
      argv: ["fixture"],
      exitCode: 0,
      startedAt: "2026-08-21T00:00:00Z",
      finishedAt: "2026-08-21T00:01:00Z",
    },
    isolation: {
      sutUser: "openclaw-sut",
      trustedHarnessRootOwned: true,
      noSudo: true,
      imdsBlocked: true,
      environmentClean: true,
      cachesEmptyBefore: true,
      tailscaleRequested: false,
      tailscaleMetadataAbsent: true,
    },
    artifacts: [{ path: artifact, size: contents.length, sha256: sha256(contents) }],
    lease: { provider: "aws", market: "on-demand", cleanupPolicy: "always" },
  });
  writeJson(timing, {
    provider: "aws",
    leaseId: "cbx_0123456789ab",
    runId: "run_0123456789ab",
    exitCode: 0,
  });
  const expected = join(root, "expected.json");
  writeJson(expected, { ...readJson(evidence), timing: readJson(timing), stopped: true });
  return { artifact, evidence, output, payload, root, timing, expected };
}

function verify(files: ReturnType<typeof fixture>) {
  return spawnSync(
    "bash",
    [
      SCRIPT,
      "verify",
      "mock-provider",
      files.timing,
      "cbx_0123456789ab",
      files.evidence,
      files.payload,
      files.output,
      files.expected,
    ],
    { cwd: files.root, encoding: "utf8" },
  );
}

function prepareSut(
  options: {
    fault?: string;
    family?: number;
    code?: number;
    output?: string;
    runner?: boolean;
  } = {},
) {
  const root = tempDirs.make("performance-imds-");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "curl"),
    `#!${process.execPath}
const fs = require("node:fs");
const root = ${JSON.stringify(root)}, options = ${JSON.stringify(options)};
const args = process.argv.slice(2);
fs.appendFileSync(root + "/curl-calls", JSON.stringify({args, env:process.env}) + "\\n");
if (args.includes("--version")) {
  if (options.fault === "version") process.exit(2);
  console.log("curl fixture\\nProtocols: " + (options.fault === "http" ? "https" : "http https"));
  console.log("Features: " + (options.fault === "ipv6" ? "SSL" : "IPv6 SSL"));
  process.exit(0);
}
const family = args.some((arg) => arg.includes("fd00:ec2::254")) ? 6 : 4;
const selected = family === (options.family ?? 6);
const code = selected ? (options.code ?? 7) : 7;
const output = selected ? (options.output ?? "000") : "000";
// Model --fail's nonzero result on reachable HTTP errors in the original probe.
if (args.some((arg) => /^-[^-]*f/.test(arg)) && Number(output) >= 400) process.exit(22);
if (args.includes("--write-out")) process.stdout.write(output);
process.exit(code);
`,
    { mode: 0o755 },
  );
  const prepareName = options.runner ? "prepare_runner" : "prepare_sut";
  const prepareStart = scriptSource.indexOf(`${prepareName}() {`);
  const systemdStart = scriptSource.indexOf(
    options.runner
      ? "\n  # The trusted runner can become only B."
      : '\n  loginctl enable-linger "$SUT_USER"',
    prepareStart,
  );
  expect(prepareStart).toBeGreaterThan(0);
  expect(systemdStart).toBeGreaterThan(prepareStart);
  // Execute the real preparation gates; systemd startup is outside this fixture.
  const preparation = scriptSource.slice(prepareStart, systemdStart);
  const result = shell(
    `
id() {
  [[ "\${1:-}" == -u ]] || return 1
  if [[ "$2" == openclaw-bench ]]; then printf '12346\\n'; else printf '12345\\n'; fi
}
useradd() { :; }
install() { :; }
chmod() { :; }
find() { :; }
runuser() {
  [[ "$1:$2:$3:$4:$5:$6:$7" == "-u:$ROLE:--:/usr/bin/env:-C:/home/$ROLE:-i" ]] || exit 90
  [[ "\${*: -3}" != "sudo -n true" ]] || return 1
  shift 7
  local arg args=()
  for arg in "$@"; do
    [[ "$arg" != curl ]] || arg="$ROOT/bin/curl"
    args+=("$arg")
  done
  /usr/bin/env -i "\${args[@]}"
}
command() {
  [[ "$1:$2" != "-v:$MISSING_TOOL" ]] || return 1
  builtin command "$@"
}
rule() {
  printf '%s\\n' "$*" >> "$ROOT/rules"
  [[ "$FAULT" != "$1:$2" ]]
}
iptables() { rule 4 "$@"; }
ip6tables() { rule 6 "$@"; }
${preparation}
}
${prepareName}
printf handoff > "$ROOT/handoff"
`,
    {
      HOME: root,
      PATH: `${bin}:/usr/bin:/bin`,
      ROOT: root,
      ROLE: options.runner ? "openclaw-bench" : "openclaw-sut",
      FAULT: options.fault ?? "",
      MISSING_TOOL: options.fault?.startsWith("missing:")
        ? options.fault.slice("missing:".length)
        : "",
      HTTP_PROXY: "http://proxy.invalid",
      HTTPS_PROXY: "http://proxy.invalid",
      ALL_PROXY: "http://proxy.invalid",
    },
    [],
    5000,
  );
  return {
    result,
    handoff: existsSync(join(root, "handoff")),
    rules: linesIfPresent(join(root, "rules")),
    probes: linesIfPresent(join(root, "curl-calls")).map(
      (line) => JSON.parse(line) as { args: string[]; env: Record<string, string> },
    ),
  };
}

describe("OpenClaw performance Crabbox boundary", () => {
  it.each([false, true])(
    "requires verified dual-stack IMDS denial before handoff (runner=%s)",
    (runner) => {
      const run = prepareSut({ runner });
      expect(run.result.status, run.result.stderr).toBe(0);
      expect(run.handoff).toBe(true);
      expect(run.rules).toEqual(
        [
          [4, "169.254.169.254/32"],
          [4, "169.254.170.2/32"],
          [6, "fd00:ec2::254/128"],
        ].flatMap(([family, destination]) =>
          ["-I", "-C"].map(
            (operation) =>
              `${family} ${operation} OUTPUT -m owner --uid-owner ${runner ? 12346 : 12345} -d ${destination} -j REJECT`,
          ),
        ),
      );
      const urls = [
        "http://169.254.169.254/latest/meta-data/",
        "http://[fd00:ec2::254]/latest/meta-data/",
      ];
      const probes = run.probes.filter(({ args }) => !args.includes("--version"));
      expect(probes).toHaveLength(urls.length);
      for (const [index, probe] of probes.entries()) {
        expect(probe.args).toEqual(
          `-q -${index === 0 ? 4 : 6} --noproxy * --silent --connect-timeout 1 --max-time 2 --output /dev/null --write-out %{http_code} ${urls[index]}`.split(
            " ",
          ),
        );
        expect(probe.env).toMatchObject({ HOME: `/home/openclaw-${runner ? "bench" : "sut"}` });
        expect(Object.keys(probe.env).some((key) => /proxy/i.test(key))).toBe(false);
      }
    },
  );

  it.each([
    ...["6:-I", "6:-C"].map((fault) => ({ name: fault, fault })),
    ...["iptables", "curl"].map((tool) => ({
      name: `missing ${tool}`,
      fault: `missing:${tool}`,
    })),
    { name: "curl ipv6", fault: "ipv6" },
    { name: "IPv6 HTTP 401", family: 6, output: "401", code: 0 },
    { name: "IPv6 curl exit 0", code: 0 },
    { name: "IPv4 timeout", family: 4, code: 28 },
    { name: "HTTP response despite connection failure", output: "401", code: 7 },
    { name: 'malformed status "000\\n"', output: "000\n" },
  ])("blocks IMDS preparation without candidate handoff: $name", (options) => {
    const run = prepareSut(options);
    expect(run.result.error).toBeUndefined();
    expect(run.result.status, run.result.stderr).not.toBe(0);
    expect(run.handoff).toBe(false);
    if ("fault" in options) {
      expect(run.probes.filter(({ args }) => !args.includes("--version"))).toEqual([]);
    }
  });

  it.each(["regular", "hardlink", "redirected-parent", "existing-output", "reserved-cli"])(
    "collects only bounded diagnostic bytes without candidate PATH: %s",
    (kind) => {
      const root = tempDirs.make("performance-diagnostic-collector-");
      const source = join(root, "candidate");
      const destination = join(root, "runner");
      const subtree = kind.startsWith("reserved-")
        ? ".artifacts/openclaw-performance/source/mock-provider"
        : ".artifacts/source";
      const relative = `${subtree}/${kind === "reserved-cli" ? "cli-startup.json" : "profile.json"}`;
      mkdirSync(join(source, subtree), { recursive: true });
      mkdirSync(destination);
      const input = join(source, relative);
      writeFileSync(input, '{"diagnostic":true}');
      if (kind === "hardlink") {
        linkSync(input, join(root, "other-link"));
      } else if (kind === "redirected-parent") {
        mkdirSync(join(root, "redirect"));
        symlinkSync(join(source, ".artifacts"), join(root, "redirect/.artifacts"));
      } else if (kind === "existing-output") {
        mkdirSync(join(destination, ".artifacts/source"), { recursive: true });
        writeFileSync(join(destination, relative), "runner-owned");
      }
      const result = shell(
        `
as_sut() {
  case "$1" in
    /usr/bin/realpath) shift; command realpath "$@" ;;
    /usr/bin/find) shift; /usr/bin/find "$@" ;;
    /usr/bin/stat)
      if [[ "$PLATFORM" == darwin ]]; then
        field="$3"; shift 3
        case "$field" in %h) /usr/bin/stat -f %l "$@" ;; %s) /usr/bin/stat -f %z "$@" ;; *) exit 93 ;; esac
      else "$@"; fi ;;
    *) printf 'candidate PATH would execute: %s\\n' "$1" >&2; exit 94 ;;
  esac
}
install() {
  "$NODE" -e 'const fs=require("node:fs"),p=require("node:path"),a=process.argv.slice(1); fs.mkdirSync(p.dirname(a.at(-1)),{recursive:true}); fs.copyFileSync(a.at(-2),a.at(-1));' -- "$@"
}
chown() { :; }
collect_diagnostics "$SOURCE" "$DESTINATION" "$SUBTREE"
`,
        {
          PATH: process.env.PATH,
          NODE: process.execPath,
          PLATFORM: process.platform,
          SOURCE: kind === "redirected-parent" ? join(root, "redirect") : source,
          DESTINATION: destination,
          SUBTREE: subtree,
        },
      );
      expect(result.status, result.stderr).toBe(kind === "regular" ? 0 : 1);
      if (kind === "regular") {
        expect(readFileSync(join(destination, relative), "utf8")).toBe('{"diagnostic":true}');
      } else if (kind === "existing-output") {
        expect(readFileSync(join(destination, relative), "utf8")).toBe("runner-owned");
      } else {
        expect(existsSync(join(destination, relative))).toBe(false);
      }
      expect(result.stderr).not.toContain("candidate PATH would execute");
      if (kind.startsWith("reserved-")) {
        expect(result.stderr).toContain("cannot supply runner measurement files");
      }
    },
  );

  it.each([
    { name: "adapted gated matrix 17", matrixExit: 17, gated: true, adapted: true, expected: 0 },
    { name: "rejected gated matrix 17", matrixExit: 17, gated: true, expected: 17 },
    { name: "bundle failure after matrix 17", matrixExit: 17, bundleExit: 31, expected: 31 },
    { name: "candidate index cannot waive runner CLI", lane: "source", expected: 0 },
    { name: "source summary failure", lane: "source", summaryExit: 37, expected: 37 },
    { name: "custom diagnostic summary", admitted: false, expected: 0 },
    { name: "custom failed evidence summary", admitted: false, validationExit: 1, expected: 1 },
    {
      name: "custom setup failure",
      admitted: false,
      setupExit: 23,
      collectionExit: 41,
      expected: 23,
    },
    { name: "custom unsafe collection", admitted: false, collectionExit: 41, expected: 41 },
    { name: "custom summary failure", admitted: false, summaryExit: 37, expected: 37 },
  ])("finalizes quiesced workloads with trusted phase policy: $name", (entry) => {
    const root = tempDirs.make("performance-failed-export-");
    const start = scriptSource.indexOf('  set +e\n  (\n    set -e\n    as_sut "$0" __prepare');
    const end = scriptSource.indexOf("\n}\n\nverify_payload()", start);
    expect(start).toBeGreaterThan(0);
    const result = shell(
      `
as_sut() {
  case "\${2:-}" in
    __sut)
      if [[ "$LANE" == source ]]; then
        mkdir -p "$ROOT/openclaw/.artifacts/openclaw-performance/source/mock-provider"
        printf 'candidate skip claim' > "$ROOT/openclaw/.artifacts/openclaw-performance/source/mock-provider/index.md"
      fi
      return 0 ;;
    __prepare) return "$SETUP_EXIT" ;;
    __build) return 0 ;;
  esac
  printf '%s\\n' "$SHA"
}
as_runner() {
  case "\${2:-}" in
    __sut) shift 2; run_sut "$@" ;;
    __validate-kova)
      shift 2
      printf '%s\\n' "\${12}" > "$ROOT/validated-matrix-exit"
      if [[ "$ADMITTED" == false ]]; then
        mkdir -p "$ROOT/.artifacts/kova/summaries"
        printf 'candidate-derived summary\\n' > "$ROOT/.artifacts/kova/summaries/mock-provider.md"
      fi
      ((VALIDATION_EXIT == 0)) || return "$VALIDATION_EXIT"
      [[ "$GATED" != true || "$ADAPTED" == true ]] || return "\${12}"
      ;;
    __source-cli) printf runner-measurement > "$ROOT/runner-cli" ;;
    *)
      if [[ "$1" == /bin/sh && "$SUMMARY_EXIT" != 0 ]]; then return "$SUMMARY_EXIT"
      elif [[ "$1" == /usr/bin/git ]]; then printf '%s\\n' "$SHA"
      elif [[ "$1" == /usr/bin/stat ]]; then command node -e 'console.log(require("node:fs").statSync(process.argv[1]).size)' "$4"
      elif [[ "$1" == /usr/bin/cat ]]; then command cat "$2"
      else "$@"; fi ;;
  esac
}
npm() { :; }
candidate_transport() { printf '{}'; }
node() {
  if [[ "$1" == "$ROOT/kova/bin/kova.mjs" ]]; then
    shift
    case "$1 $2" in
      "matrix plan") printf '{"controls":{"include":["scenario:probe"]}}' ;;
      "matrix run") return "$MATRIX_EXIT" ;;
      "report bundle") printf '{}'; return "$BUNDLE_EXIT" ;;
      *) return 64 ;;
    esac
  elif [[ "$1" == "$ROOT/helpers/lib/kova-report-selector.mjs" ]]; then
    printf '%s\\n' "$ROOT/report.json"
  elif [[ "$1" == "$ROOT/helpers/openclaw-performance-source-summary.mjs" ]]; then
    return "$SUMMARY_EXIT"
  else
    command node "$@"
  fi
}
collect_diagnostics() {
  ((COLLECTION_EXIT == 0)) || { echo "unsafe diagnostic fixture" >&2; exit "$COLLECTION_EXIT"; }
  [[ "$3" != .artifacts/openclaw-performance/source || -d "$1/$3" ]] ||
    die "diagnostic subtree is missing"
}
quiesce_sut() { printf quiesced > "$ROOT/quiesced"; }
write_payload() {
  printf '%s\\n' "\${19:-missing}" > "$ROOT/exported"
  ((COLLECTION_EXIT == 0)) || return 43
}
finish() {
  local root="$ROOT" openclaw_sha="$SHA" kova_sha="$SHA" status
  local kova="$ROOT/kova" results="$ROOT" workload_results="$ROOT" admitted="$ADMITTED" executor=as_runner
  [[ "$admitted" != false ]] || executor=as_sut
  local lane="$LANE" profile=diagnostic repeat=1 contract=canonical source_cli_supported=true
  local include_filters=scenario:probe expected_entries=- fail_on_regression="$GATED"
  local helpers="$ROOT/helpers" model=fixture-model require_instrumented=true
  local control_workspace="$ROOT" tested_ref=fixture workflow_sha="$SHA"
  local run_id=123 run_attempt=1 crabbox_version=fixture
  local started_at=2026-09-07T00:00:00Z finished_at
  mkdir -p "$ROOT/.artifacts/performance-crabbox/$lane"
${scriptSource.slice(start, end)}
}
finish
`,
      {
        HOME: root,
        PATH: process.env.PATH,
        ROOT: root,
        SHA: "a".repeat(40),
        LANE: entry.lane ?? "mock-provider",
        SETUP_EXIT: String(entry.setupExit ?? 0),
        MATRIX_EXIT: String(entry.matrixExit ?? 0),
        BUNDLE_EXIT: String(entry.bundleExit ?? 0),
        SUMMARY_EXIT: String(entry.summaryExit ?? 0),
        COLLECTION_EXIT: String(entry.collectionExit ?? 0),
        GATED: String(entry.gated ?? false),
        ADAPTED: String(entry.adapted ?? false),
        ADMITTED: String(entry.admitted ?? true),
        VALIDATION_EXIT: String(entry.validationExit ?? 0),
      },
      [SCRIPT],
    );
    expect(result.status, result.stderr).toBe(entry.expected);
    expect(existsSync(join(root, "quiesced"))).toBe(true);
    expect(readText(root, "exported")).toBe(`${entry.expected}\n`);
    const receipt = `.artifacts/performance-crabbox/${entry.lane ?? "mock-provider"}/workload-result.json`;
    expect(readJson(join(root, receipt))).toMatchObject({
      exitCode: entry.expected,
      exportExitCode: entry.collectionExit ? 43 : 0,
    });
    if (entry.lane === "source") {
      expect(existsSync(join(root, "runner-cli"))).toBe(!entry.setupExit);
      if (!entry.setupExit) {
        expect(readText(root, "runner-cli")).toBe("runner-measurement");
      }
    } else if (entry.admitted === false) {
      const summaryPath = join(root, ".artifacts/kova/summaries/mock-provider.md");
      if (entry.collectionExit) {
        expect(existsSync(summaryPath)).toBe(false);
        expect(existsSync(join(root, "validated-matrix-exit"))).toBe(false);
      } else if (!entry.summaryExit) {
        const summary = readFileSync(summaryPath, "utf8");
        expect(summary).toContain("candidate-derived summary");
        expect(summary).toContain("candidate-produced diagnostics only; not gate evidence");
      }
    } else if (!entry.setupExit && !entry.bundleExit) {
      expect(readText(root, "validated-matrix-exit")).toBe(`${entry.matrixExit ?? 0}\n`);
    }
  });

  it.skipIf(process.getuid?.() === 0)(
    "prepares private collector-owned export ancestors before sudo",
    () => {
      const root = tempDirs.make("openclaw-performance-export-owner-");
      const script = join(root, ".crabbox/scripts/harness.sh");
      const bin = join(root, "bin");
      mkdirSync(join(root, ".crabbox/scripts"), { recursive: true });
      mkdirSync(bin);
      // The fixture supplies its own filesystem root; production requires the raw lease workspace.
      writeFileSync(
        script,
        readFileSync(SCRIPT, "utf8").replace(
          '"/work/crabbox/$CRABBOX_LEASE_ID/openclaw"',
          JSON.stringify(root),
        ),
      );
      writeFileSync(join(bin, "sudo"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const result = spawnSync(
        "bash",
        [
          script,
          "remote",
          "source",
          "a".repeat(40),
          "b".repeat(40),
          "c".repeat(40),
          "fixture",
          "diagnostic",
          "1",
          "canonical",
          "-",
          "-",
          "false",
          "1",
          "1",
          "fixture-client",
          "mock-model",
          "false",
          "b".repeat(40),
        ],
        {
          env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH}`,
            CRABBOX_LEASE_ID: "cbx_0123456789ab",
            CRABBOX_RUN_ID: "run_fixture",
            HOME: root,
          },
          encoding: "utf8",
        },
      );
      expect(result.status, result.stderr).toBe(0);
      for (const path of [
        ".artifacts",
        ".artifacts/performance-crabbox",
        ".artifacts/performance-crabbox/source",
      ]) {
        const metadata = statSync(join(root, path));
        expect(metadata.uid).toBe(process.getuid?.());
        expect(metadata.mode & 0o777).toBe(0o700);
      }
    },
  );

  describe("native Kova evidence", () => {
    const helperDirs = useAutoCleanupTempDirTracker(afterAll);
    let helpers: string;
    beforeAll(() => {
      helpers = helperDirs.make("openclaw-performance-kova-helpers-");
      buildSync({
        entryPoints: [
          "scripts/lib/kova-report-selector.mjs",
          "scripts/lib/kova-workflow-evidence.mts",
          "scripts/lib/kova-report-gate.mts",
          "scripts/kova-ci-summary.mts",
        ],
        bundle: true,
        platform: "node",
        format: "esm",
        outbase: "scripts",
        outdir: helpers,
        outExtension: { ".js": ".mjs" },
      });
    });

    const defaults = {
      gated: false,
      sutExit: 0,
      records: true,
      planFilter: "scenario:probe",
      admitted: true,
    };
    const kovaCase = (name: string, overrides: Partial<typeof defaults>, expected: number) => ({
      name,
      ...defaults,
      ...overrides,
      expected,
    });
    it.each([
      kovaCase("advisory BLOCKED", { sutExit: 17 }, 0),
      kovaCase("unadaptable gated BLOCKED", { gated: true, sutExit: 17 }, 17),
      kovaCase("wrong plan filters", { planFilter: "scenario:wrong" }, 1),
      kovaCase("custom Kova cannot approve a gate", { gated: true, admitted: false }, 1),
      kovaCase("custom Kova invalid evidence", { records: false, admitted: false }, 1),
    ])(
      "enforces native Kova evidence and gate semantics: $name",
      ({ gated, sutExit, records, planFilter, admitted, expected }) => {
        const root = tempDirs.make("openclaw-performance-kova-contract-");
        const openclaw = join(root, "openclaw");
        const artifact = (path: string) => join(openclaw, ".artifacts/kova", path);
        mkdirSync(artifact("summaries"), { recursive: true });
        const common = { profile: { id: "diagnostic" }, target: `local-build:${openclaw}` };
        const controls = { include: ["scenario:probe"], repeat: 1 };
        writeJson(artifact("plans/mock-provider.json"), {
          ...common,
          schemaVersion: "kova.matrix.plan.v1",
          controls: { ...controls, include: [planFilter] },
          entries: [{ scenario: { id: "probe" }, state: { id: "fresh" }, status: "SELECTED" }],
        });
        writeJson(artifact("reports/mock-provider/report.json"), {
          ...common,
          schemaVersion: "kova.report.v1",
          mode: "execution",
          controls,
          auth: { requestedMode: "mock" },
          summary: { statuses: { BLOCKED: 1 } },
          records: records
            ? [
                {
                  scenario: "probe",
                  state: { id: "fresh" },
                  status: "BLOCKED",
                  repeat: { total: 1, index: 1 },
                  auth: { mode: "mock" },
                  failureReason: "fixture blocked prerequisite",
                },
              ]
            : [],
        });
        writeJson(artifact("bundles/mock-provider/bundle.json"), { files: [] });
        const result = shell(
          `
node() { printf '%s\\n' "$*" >> "$ROOT/helper-calls"; command node "$@"; }
validate_kova mock-provider "$ROOT" diagnostic 1 scenario:probe - "$GATED" "$HELPERS" mock-model true "$ROOT/openclaw" "$SUT_EXIT" "$ADMITTED"
`,
          {
            ...process.env,
            ROOT: root,
            HELPERS: helpers,
            HOME: root,
            SUT_EXIT: String(sutExit),
            GATED: String(gated),
            ADMITTED: String(admitted),
          },
        );
        expect(result.status, result.stderr).toBe(expected);
        if (planFilter !== "scenario:probe") {
          expect(result.stderr).toContain("did not preserve the requested include filters");
        } else {
          const calls = readFileSync(join(root, "helper-calls"), "utf8");
          expect(calls).toContain("kova-workflow-evidence.mjs");
          expect(calls.includes("kova-report-gate.mjs")).toBe(gated && records && sutExit !== 0);
          if (gated && sutExit !== 0) {
            expect(calls).toContain("--require-instrumented-performance-contract");
          }
          if (records) {
            expect(readFileSync(artifact("summaries/mock-provider.md"), "utf8")).toContain(
              "fixture blocked prerequisite",
            );
          } else {
            expect(result.stderr).toContain("coverage");
          }
        }
      },
    );
  });

  it("uses dedicated AWS on-demand leases with no caches or forwarded environment", () => {
    expect(parse(readFileSync(CONFIG, "utf8"))).toMatchObject({
      provider: "aws",
      serverType: "c7a.24xlarge",
      capacity: { market: "on-demand" },
      cache: { pnpm: false, npm: false, docker: false, git: false, purgeOnRelease: true },
      env: { allow: ["OPENCLAW_PERFORMANCE_NO_ENV"] },
      sync: {
        gitSeed: false,
        fingerprint: false,
        include: [
          SCHEMA,
          "scripts/openclaw-performance-crabbox.sh",
          ".github/crabbox/performance-control/ocm",
          ".github/crabbox/performance-control/ocm.sha256",
          ...[
            "bench-cli-startup.mjs",
            "kova-ci-summary.mjs",
            "lib/kova-report-gate.mjs",
            "lib/kova-report-selector.mjs",
            "lib/kova-workflow-evidence.mjs",
            "openclaw-performance-source-summary.mjs",
          ].map((name) => `.github/crabbox/performance-control/helpers/${name}`),
        ],
      },
    });
  });

  it("pins UID handoff and post-quiescence Git commands to trusted executables", () => {
    for (const command of [
      'runuser -u "$SUT_USER" -- /usr/bin/env -C "/home/${SUT_USER}" -i',
      "GIT_CONFIG_GLOBAL=/dev/null",
      '"$executor" /usr/bin/git -C "$destination" rev-parse HEAD',
      'as_sut /usr/bin/git -C "$root/openclaw" rev-parse HEAD',
      '"$executor" /usr/bin/git -C "$kova" rev-parse HEAD',
      'pkill -KILL -u "$uid"',
    ]) {
      expect(scriptSource).toContain(command);
    }
  });

  it("verifies tar paths, sizes, hashes, and lease cleanup before export", () => {
    const files = fixture();
    const result = verify(files);

    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(join(files.root, files.artifact), "utf8")).toBe('{"status":"ok"}\n');
    const output = readJson(files.output);
    expect(output.lease).toEqual({
      provider: "aws",
      market: "on-demand",
      cleanupPolicy: "always",
      id: "cbx_0123456789ab",
      stopped: true,
      stopError: "",
    });
    expect(output.isolation).toMatchObject({
      tailscaleRequested: false,
      tailscaleMetadataAbsent: true,
    });
  });

  it("rejects artifact hash drift", () => {
    const files = fixture();
    const evidence = readJson(files.evidence) as { artifacts: Array<{ sha256: string }> };
    expectDefined(evidence.artifacts[0], "artifact evidence").sha256 = "0".repeat(64);
    writeJson(files.evidence, evidence);

    const result = verify(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("payload hash mismatch");
  });

  it.each(["openclawSha", "testedRef", "kovaSha", "workflow", "crabbox", "command"])(
    "rejects a schema-valid payload with the wrong trusted %s",
    (field) => {
      const files = fixture();
      const evidence = readJson(files.evidence);
      if (field === "workflow") {
        evidence.workflow.runAttempt = "2";
      } else if (field === "crabbox") {
        evidence.crabbox.version = "different-client";
      } else if (field === "command") {
        evidence.command.finishedAt = "2026-08-21T00:02:00Z";
      } else {
        evidence[field] = field === "testedRef" ? "different-ref" : "d".repeat(40);
      }
      writeJson(files.evidence, evidence);
      const result = verify(files);
      expect(result.status).not.toBe(0);
      expect(existsSync(files.output)).toBe(false);
    },
  );

  it("rejects timing for a different lease", () => {
    const files = fixture();
    writeJson(files.timing, {
      leaseId: "cbx_abcdef123456",
      leaseStopped: false,
      leaseStopError: "release failed",
    });

    const result = verify(files);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Crabbox timing did not bind the expected lease");
  });
});
