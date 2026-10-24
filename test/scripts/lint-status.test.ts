import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { toErrorObject } from "../../scripts/lib/error-format.mts";
import { collectRuntimeImportClosure } from "../../scripts/lib/runtime-import-closure.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive } from "../helpers/process-wait.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import { prepareCopiedSourceModules } from "./copied-source-modules.test-support.js";
import { formatShimResult } from "./direct-run-entrypoints.test-support.js";
import { copyOxlintConfigFixture } from "./test-helpers.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());
const entries = ["run-oxlint.mjs", "run-oxlint-shards.mts", "run-lint.mts"] as const;
type Entry = (typeof entries)[number];
type Mode = "success" | "nonzero" | "signal" | "wait" | "throw" | "unjoined";

const preparedLifetime = createFixtureLifetime();
afterAll(() => preparedLifetime.cleanup());
let preparedScripts: Promise<string> | undefined;

function writeAt(root: string, relative: string, content: string | Uint8Array) {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}

async function prepareScripts() {
  const root = fs.realpathSync(preparedLifetime.createTempDir("lint-prepared-"));
  const sourceEntries = [...entries, "run-oxlint.mts", "generate-kysely-types.mts", "tsx.mjs"].map(
    (entry) => `scripts/${entry}`,
  );
  // Keep the native wrappers, but let the shared compiler own their static dependency graph.
  for (const file of collectRuntimeImportClosure(process.cwd(), sourceEntries)) {
    writeAt(root, file, fs.readFileSync(path.resolve(file)));
  }
  for (const name of ["p-map", "@openclaw/fs-safe", "json5"]) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules", name), target, "junction");
  }
  writeAt(root, "package.json", '{"type":"module"}');
  writeAt(root, "pnpm-workspace.yaml", "packages: []\n");
  writeAt(
    root,
    "node_modules/tsx/package.json",
    JSON.stringify({
      name: "tsx",
      type: "module",
      exports: { ".": "./loader.mjs", "./esm": "./loader.mjs" },
    }),
  );
  writeAt(root, "node_modules/tsx/loader.mjs", "export {};\n");
  writeAt(
    root,
    "scripts/check-control-ui-controllers.mts",
    "export function main() { return Number(process.env.FIXTURE_CONTROLLER_GUARD_EXIT || 0); }\n",
  );
  const compiled = ["run-lint", "run-oxlint", "run-oxlint-shards"];
  await prepareCopiedSourceModules(
    root,
    compiled.map((name) => `scripts/${name}.mts`),
  );
  for (const name of compiled) {
    fs.copyFileSync(
      path.join(root, "scripts", `${name}.js`),
      path.join(root, "scripts", `${name}.mts`),
    );
  }
  return root;
}

async function createLintFixture(mode: Mode, phase: string, timeout: boolean) {
  const root = fs.realpathSync(fixture.createTempDir("openclaw-lint-status-"));
  fs.cpSync(await (preparedScripts ??= prepareScripts()), root, { recursive: true });
  const write = (relative: string, content: string | Uint8Array) =>
    writeAt(root, relative, content);
  const waitForFile = write(
    "wait-for-file.mjs",
    `
import fs from "node:fs";
export function waitForFile(file) {
  return new Promise((resolve) => {
    const check = () => { if (fs.existsSync(file)) { clearInterval(poll); resolve(); } };
    const poll = setInterval(check, 50);
    poll.unref();
    check();
  });
}
`,
  );
  const toolSource = (step: string) => `
import fs from "node:fs";
import { waitForFile } from ${JSON.stringify(pathToFileURL(waitForFile).href)};
const step = ${JSON.stringify(step)};
const mode = ${JSON.stringify(step === phase ? mode : "success")};
const shard = process.argv.includes("scripts") ? "scripts" : process.argv.includes("src") ? "core" : "extensions";
const name = step === "oxlint" ? shard : step;
const lock = ".artifacts/dist-artifacts.lock";
fs.appendFileSync("steps.jsonl", JSON.stringify({ step, shard, args: process.argv.slice(2), pid: process.pid, owned: fs.existsSync(lock + "/owner.json"), claims: fs.existsSync(lock) ? fs.readdirSync(lock).filter(name => name.startsWith("child-")) : [] }) + "\\n");
if (mode !== "wait") process.stdout.write(JSON.stringify({ step, shard }) + "\\n");
process.stderr.write("diagnostic:" + name + "\\n");
if (mode === "throw") throw new Error("fixture preparation failure");
if (mode === "unjoined") throw Object.assign(new Error("fixture cleanup unverified"), { processTreeState: "indeterminate" });
if (mode === "signal") process.kill(process.pid, "SIGTERM");
else if (mode === "wait") {
  const timer = setInterval(() => {}, 1000);
  // Force the initial deadline to expire before this child can publish readiness.
  if (${timeout} && step === "oxlint") await waitForFile("watchdog-fired");
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
    process.stderr.write("drained:" + name + ":" + signal + "\\n");
    clearInterval(timer);
  });
  fs.writeFileSync(name + ".pid.tmp", String(process.pid));
  fs.renameSync(name + ".pid.tmp", name + ".pid");
  process.stdout.write(JSON.stringify({ step, shard }) + "\\n");
} else process.exitCode = mode === "nonzero" ? 7 : 0;
`;
  for (const name of ["oxlint", "stylelint"]) {
    const tool = write(`tools/${name}.mjs`, toolSource(name));
    const bin = write(
      `node_modules/.bin/${name}`,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(tool)} "$@"\n`,
    );
    fs.chmodSync(bin, 0o755);
  }
  write("scripts/prepare-extension-package-boundary-artifacts.mts", toolSource("prepare"));
  write("scripts/control-ui-i18n-verify.ts", toolSource("i18n"));
  const probe = write(
    "trailer-probe.mjs",
    `
import fs from "node:fs";
import { waitForFile } from ${JSON.stringify(pathToFileURL(waitForFile).href)};
if (${timeout}) {
  const schedule = globalThis.setTimeout;
  globalThis.setTimeout = (callback, ms, ...args) => {
    if (ms !== 1500) return schedule(callback, ms, ...args);
    // Gate only the initial shard watchdog, preserving its native clear/unref
    // handle and restoring real scheduling before readiness, grace, or cleanup.
    globalThis.setTimeout = schedule;
    return schedule(() => {
      fs.writeFileSync("watchdog-fired", JSON.stringify({ childReady: fs.existsSync("extensions.pid") }));
      void waitForFile("extensions.pid").then(() => callback(...args));
    }, ms);
  };
}
const write = process.stderr.write.bind(process.stderr);
process.stderr.write = (chunk, ...args) => {
  if (String(chunk).includes("FAILED (exit")) fs.appendFileSync("trailers.jsonl", JSON.stringify({
    text: String(chunk).trim(),
    owned: fs.existsSync(".artifacts/dist-artifacts.lock/owner.json"),
    claims: fs.existsSync(".artifacts/dist-artifacts.lock") ? fs.readdirSync(".artifacts/dist-artifacts.lock").filter(name => name.startsWith("child-")) : [],
    live: fs.existsSync("steps.jsonl") ? fs.readFileSync("steps.jsonl", "utf8").trim().split("\\n").map(line => JSON.parse(line).pid).filter(pid => {
      try { process.kill(pid, 0); return true; } catch { return false; }
    }) : [],
  }) + "\\n");
  return write(chunk, ...args);
};
`,
  );
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_CONTROLLER_GUARD_EXIT: phase === "controllers" && mode === "nonzero" ? "7" : "0",
    OPENCLAW_OXLINT_SHARDS_SERIAL: "1",
  };
  for (const key of [
    "NODE_OPTIONS",
    "NODE_PATH",
    "PNPM_CONFIG_MODULES_DIR",
    "npm_config_modules_dir",
    "OPENCLAW_OXLINT_SKIP_PREPARE",
  ]) {
    delete env[key];
  }
  return { root, probe, env };
}

type Step = {
  step: string;
  shard: string;
  args: string[];
  pid: number;
  owned: boolean;
  claims: string[];
};

const lintPhases = ["i18n", "prepare", "oxlint", "stylelint"];
function expectTrailer(
  trailers: { text: string }[],
  code: number,
  entry: Entry = "run-lint.mts",
  owned = false,
) {
  const tool = entry === "run-lint.mts" ? "lint" : "oxlint";
  expect(trailers).toEqual(
    code ? [{ text: `[${tool}] FAILED (exit ${code})`, owned, claims: [], live: [] }] : [],
  );
}

function readRows<T>(root: string, name: string): T[] {
  const file = path.join(root, name);
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as T)
    : [];
}

async function runLintFixture(
  mode: Mode,
  signal: AbortSignal,
  {
    entry = "run-lint.mts",
    phase = "oxlint",
    parallel = false,
    timeout = false,
    forwarded,
  }: {
    entry?: Entry;
    phase?: string;
    parallel?: boolean;
    timeout?: boolean;
    forwarded?: "SIGINT" | "SIGTERM";
  } = {},
) {
  const { root, probe, env } = await createLintFixture(mode, phase, timeout);
  const args =
    entry === "run-oxlint.mjs"
      ? ["--tsconfig", "extensions/tsconfig.json", "extensions"]
      : parallel
        ? ["--only=core", "--only=extensions", "--only=scripts"]
        : ["--only=extensions"];
  let readiness: Promise<void> | undefined;
  const command = fixture.track(
    runNodeScript(
      [
        "--import",
        pathToFileURL(probe).href,
        "--import",
        pathToFileURL(path.join(root, "scripts/tsx.mjs")).href,
        path.join(root, "scripts", entry),
        ...args,
      ],
      {
        ...env,
        OPENCLAW_OXLINT_SHARDS_SERIAL: parallel ? "0" : "1",
        OPENCLAW_OXLINT_SHARD_HEARTBEAT_MS: "0",
        OPENCLAW_OXLINT_SHARD_TIMEOUT_MS: timeout ? "1500" : "0",
      },
      undefined,
      {
        cwd: root,
        signal,
        requireProcessTreeExit: true,
        onReady(child, readOutput) {
          if (forwarded) {
            const ready = createDeferred();
            const line = JSON.stringify({ step: phase, shard: "extensions" }) + "\n";
            // Wait-mode tools emit their one stdout row only after installing
            // signal handlers. The managed command joins this same output pipe.
            child.stdout?.on("data", () => {
              if (readOutput().stdout.includes(line)) {
                ready.resolve();
              }
            });
            // The lifetime schedules this after command is initialized and joins it during cleanup.
            readiness = fixture.run(async () => {
              const file = path.join(root, phase === "oxlint" ? "extensions.pid" : `${phase}.pid`);
              await withinTest(
                awaitGateBeforeSettlement(
                  ready.promise,
                  command.then((result) => {
                    if (result.error !== undefined) {
                      throw new Error(`Child failed before writing ${file}`, {
                        cause: toErrorObject(
                          result.error,
                          "Lint command failed before signal readiness",
                        ),
                      });
                    }
                  }),
                  `Child exited before writing ${file}`,
                ),
                signal,
              );
              child.kill(forwarded);
            });
          }
        },
      },
    ),
  );
  const result = await command;
  await readiness;
  const details = formatShimResult(result);
  expect(result.error, details).toBeUndefined();
  if (timeout) {
    expect(readRows(root, "watchdog-fired"), details).toEqual([{ childReady: false }]);
  }
  const steps = readRows<Step>(root, "steps.jsonl");
  expect(steps.length, details).toBeGreaterThan(0);
  for (const step of steps) {
    expect(isProcessAlive(step.pid), details).toBe(false);
  }
  expect(fs.existsSync(path.join(root, ".artifacts/dist-artifacts.lock/owner.json")), details).toBe(
    mode === "unjoined",
  );
  // Every stdout line remains machine-readable, including parallel sibling output.
  expect(
    result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toHaveLength(steps.length);
  const trailers = readRows<{ text: string }>(root, "trailers.jsonl");
  expect(result.stderr.match(/FAILED \(exit/g) ?? [], details).toHaveLength(
    result.status === 0 ? 0 : 1,
  );
  if (result.status !== 0) {
    expect(result.stderr.trim().split("\n").at(-1), details).toBe(trailers[0]?.text);
  }
  return { result, details, steps, trailers };
}

describe.skipIf(process.platform === "win32")("lint failure reporting boundary", () => {
  beforeAll(() => (preparedScripts = prepareScripts()));

  it("run-oxlint.mjs preserves real oxlint warning/error exits (GitHub Actions: true)", ({
    signal,
  }) =>
    fixture.run(async () => {
      const { root, env } = await createLintFixture("success", "oxlint", false);
      for (const name of ["oxlint", "tsgolint"]) {
        const bin = path.join(root, "node_modules/.bin", name);
        fs.rmSync(bin, { force: true });
        fs.symlinkSync(path.resolve("node_modules/.bin", name), bin);
      }
      copyOxlintConfigFixture(root);
      fs.mkdirSync(path.join(root, "extensions/sample"), { recursive: true });
      fs.writeFileSync(
        path.join(root, "extensions/tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true }, include: ["**/*.ts"] }),
      );
      const source = path.join(root, "extensions/sample/oversized.ts");
      const warningSource = `export const values = [\n${"  0,\n".repeat(700)}];\n`;
      const args = ["--tsconfig", "extensions/tsconfig.json", "extensions"];
      for (const hasError of [false, true]) {
        fs.writeFileSync(source, warningSource + (hasError ? "export var legacy = 1;\n" : ""));
        const result = await fixture.track(
          runNodeScript(
            [path.join(root, "scripts/run-oxlint.mjs"), ...args, "--threads=1"],
            { ...env, CI: "true", GITHUB_ACTIONS: "true" },
            10_000,
            { cwd: root, signal, requireProcessTreeExit: true },
          ),
        );
        const details = formatShimResult(result);
        expect(result.error, details).toBeUndefined();
        expect(result.status, details).toBe(hasError ? 1 : 0);
        expect(result.stdout, details).toContain("eslint(max-lines)");
        expect(result.stdout, details).toContain("warning");
        expect(result.stdout, details).toContain(hasError ? "1 error" : "0 errors");
        expect(result.stdout, details).toContain("1 warning");
        if (hasError) {
          expect(result.stdout, details).toContain("eslint(no-var)");
        }
      }
    }));

  type Scenario = {
    mode: Mode;
    code: number;
    entry?: Entry;
    phase?: string;
    timeout?: boolean;
    parallel?: boolean;
    forwarded?: "SIGINT" | "SIGTERM";
    allPhases?: boolean;
    claim?: boolean;
    stderr?: string[];
  };
  const scenarios: Scenario[] = [
    { entry: "run-oxlint.mjs", mode: "nonzero", code: 7, claim: false },
    { entry: "run-oxlint-shards.mts", mode: "nonzero", code: 7, claim: true },
    { mode: "success", code: 0, allPhases: true, claim: true },
    { mode: "signal", code: 143, claim: true },
    ...["controllers", "i18n", "oxlint"].map((phase): Scenario => ({
      mode: "nonzero",
      code: 7,
      phase,
      allPhases: true,
    })),
    { mode: "wait", code: 124, timeout: true, stderr: ["timed out", "drained:extensions:SIGTERM"] },
    { mode: "throw", code: 1, phase: "prepare", stderr: ["fixture preparation failure"] },
    { mode: "nonzero", code: 7, parallel: true },
    {
      mode: "unjoined",
      code: 1,
      phase: "prepare",
      stderr: ["fixture cleanup unverified", "child cleanup unverified; retained"],
    },
    ...(
      [
        ["run-oxlint.mjs", "oxlint", "SIGTERM"],
        ["run-lint.mts", "oxlint", "SIGINT"],
        ["run-lint.mts", "i18n", "SIGTERM"],
        ["run-lint.mts", "prepare", "SIGINT"],
        ["run-lint.mts", "stylelint", "SIGTERM"],
      ] as const
    ).map(([entry, phase, forwarded]): Scenario => ({
      entry,
      phase,
      forwarded,
      mode: "wait",
      code: forwarded === "SIGINT" ? 130 : 143,
      stderr: [`drained:${phase === "oxlint" ? "extensions" : phase}:${forwarded}`],
    })),
  ];
  it.for(scenarios)("$entry $phase $mode settles before reporting $code", (scenario, { signal }) =>
    fixture.run(async () => {
      const { mode, code, entry = "run-lint.mts", stderr = [], allPhases, claim } = scenario;
      const { result, details, steps, trailers } = await runLintFixture(mode, signal, scenario);
      expect(result.status, details).toBe(code);
      expectTrailer(trailers, code, entry, mode === "unjoined");
      for (const message of stderr) {
        expect(result.stderr, details).toContain(message);
      }
      if (claim !== undefined) {
        const lint = steps.find((step) => step.step === "oxlint");
        expect(lint, details).toMatchObject({ owned: true });
        if (claim) {
          expect(lint!.claims).toHaveLength(1);
        }
        if (code) {
          expect(result.stderr).not.toContain("[oxlint:extensions] finished");
        }
      }
      if (allPhases) {
        expect(
          steps.map((step) => step.step),
          details,
        ).toEqual(lintPhases);
      }
      if (mode === "success") {
        expect(steps.find((step) => step.step === "prepare")?.args).toEqual([
          "--mode=package-boundary",
        ]);
      }
      if (mode === "throw") {
        expect(steps.some((step) => step.step === "oxlint")).toBe(false);
      }
      if (scenario.parallel) {
        expect(
          steps
            .filter((step) => step.step === "oxlint")
            .map((step) => step.shard)
            .toSorted(),
        ).toEqual(["core", "extensions", "scripts"]);
      }
    }),
  );
});
