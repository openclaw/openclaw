import { ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsdown";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toErrorObject } from "../../scripts/lib/error-format.mts";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { isProcessAlive, waitForFixtureFile } from "../helpers/process-wait.js";
import { runNodeScript } from "../helpers/run-node-script.js";
import * as nodeScript from "../helpers/run-node-script.js";
import { formatShimResult } from "./direct-run-entrypoints.test-support.js";

const fixture = createFixtureLifetime();
afterEach(() => fixture.cleanup());
const entries = ["run-oxlint.mjs", "run-oxlint-shards.mts", "run-lint.mts"] as const;
type Entry = (typeof entries)[number];
type Mode = "success" | "nonzero" | "signal" | "wait" | "throw" | "unjoined";

let preparedScripts: Promise<Map<string, string | Uint8Array>> | undefined;

async function createLintFixture(mode: Mode, phase: string, timeout: boolean) {
  const root = fs.realpathSync(fixture.createTempDir("openclaw-lint-status-"));
  const write = (relative: string, content: string) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  };
  write("package.json", '{"type":"module"}');
  write("pnpm-workspace.yaml", "packages: []\n");
  const waitForFile = write(
    "wait-for-file.mjs",
    `
import fs from "node:fs";
export function waitForFile(file) {
  return new Promise((resolve) => {
    const check = () => { if (fs.existsSync(file)) { clearInterval(poll); resolve(); } };
    // Directory events can coalesce before the receipt rename; observe persistent state.
    const poll = setInterval(check, 50);
    poll.unref();
    check();
  });
}
`,
  );
  for (const file of [
    ...entries,
    "run-oxlint.mts",
    "run-stylelint.mts",
    "tsx.mjs",
    "windows-cmd-helpers.mjs",
    "lib/tsx-cli-shim.mjs",
    "lib/local-check-runtime.mts",
    "lib/check-limits.mts",
    "lib/direct-run.mjs",
    "lib/dist-artifact-ownership.mts",
    "lib/dist-artifact-lock.mts",
    "lib/record-shared.mjs",
    "lib/failed-trailer.mts",
    "lib/managed-child-process.mts",
    "lib/vitest-resource-ownership.mts",
    "lib/windows-taskkill.mjs",
    "lib/repo-root.mjs",
  ]) {
    write(`scripts/${file}`, fs.readFileSync(path.resolve("scripts", file), "utf8"));
  }
  for (const file of [
    "scripts/lib/process-memory.mts",
    "packages/normalization-core/src/mountinfo-path.ts",
  ]) {
    write(file, fs.readFileSync(path.resolve(file), "utf8"));
  }
  // Only this disposable fixture gets synthetic binaries; installed tools stay untouched.
  for (const name of ["p-map", "@openclaw/fs-safe", "json5"]) {
    const target = path.join(root, "node_modules", name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(path.resolve("node_modules", name), target, "junction");
  }
  // Wrappers are compiled below and synthetic tools are native JavaScript.
  // Keep loader imports without adding unrelated compiler-service children.
  write(
    "node_modules/tsx/package.json",
    JSON.stringify({
      name: "tsx",
      type: "module",
      exports: { ".": "./loader.mjs", "./esm": "./loader.mjs" },
    }),
  );
  write("node_modules/tsx/loader.mjs", "export {};\n");
  preparedScripts ??= (async () => {
    const { bundles } = await build({
      config: false,
      cwd: root,
      root,
      entry: ["scripts/run-lint.mts", "scripts/run-oxlint.mts", "scripts/run-oxlint-shards.mts"],
      outDir: root,
      unbundle: true,
      format: "esm",
      platform: "node",
      dts: false,
      clean: false,
      write: false,
      treeshake: false,
      deps: { neverBundle: ["p-map", "@openclaw/fs-safe"] },
      // These POSIX fixtures omit optional Windows Job and declaration compiler runtimes.
      inputOptions: {
        external: (id, importer) =>
          (id === "./managed-windows-job.mts" &&
            importer === path.join(root, "scripts/lib/managed-child-process.mts")) ||
          (id === "./tsdown-declaration-boundary.mts" &&
            importer === path.join(root, "scripts/lib/local-check-runtime.mts")),
      },
      outExtensions: () => ({ js: ".js" }),
      outputOptions: { entryFileNames: "[name].js", chunkFileNames: "[name].js" },
      logLevel: "silent",
    });
    const outputs = new Map<string, string | Uint8Array>();
    for (const bundle of bundles) {
      for (const output of bundle.chunks) {
        outputs.set(output.fileName, output.type === "chunk" ? output.code : output.source);
      }
      await bundle[Symbol.asyncDispose]();
    }
    return outputs;
  })();
  for (const [relative, contents] of await preparedScripts) {
    const output = path.join(root, relative);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, contents);
  }
  // The original wrapper and shard owner still select their .mts entry paths.
  for (const name of ["run-lint", "run-oxlint", "run-oxlint-shards"]) {
    fs.copyFileSync(
      path.join(root, "scripts", `${name}.js`),
      path.join(root, "scripts", `${name}.mts`),
    );
  }
  const toolSource = (step: string) => `
import fs from "node:fs";
import { waitForFile } from ${JSON.stringify(pathToFileURL(waitForFile).href)};
const step = ${JSON.stringify(step)};
const mode = ${JSON.stringify(step === phase ? mode : "success")};
const shard = process.argv.includes("scripts") ? "scripts" : process.argv.includes("src") ? "core" : "extensions";
const name = step === "oxlint" ? shard : step;
const lock = ".artifacts/dist-artifacts.lock";
fs.appendFileSync("steps.jsonl", JSON.stringify({ step, shard, args: process.argv.slice(2), pid: process.pid, owned: fs.existsSync(lock + "/owner.json"), claims: fs.existsSync(lock) ? fs.readdirSync(lock).filter(name => name.startsWith("child-")) : [] }) + "\\n");
process.stdout.write(JSON.stringify({ step, shard }) + "\\n");
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
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCLAW_OXLINT_SHARDS_SERIAL: "1" };
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
  entry: Entry,
  mode: Mode,
  signal: AbortSignal,
  {
    phase = "oxlint",
    parallel = false,
    timeout = false,
    forwarded,
  }: {
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
      10_000,
      {
        cwd: root,
        signal,
        requireProcessTreeExit: true,
        onReady(child) {
          if (forwarded) {
            // The lifetime schedules this after command is initialized and joins it during cleanup.
            readiness = fixture.run(async () => {
              const ready = path.join(root, phase === "oxlint" ? "extensions.pid" : `${phase}.pid`);
              await waitForFixtureFile(
                ready,
                command.then((result) => {
                  if (result.error !== undefined) {
                    throw toErrorObject(
                      result.error,
                      "Lint command failed before signal readiness",
                    );
                  }
                }),
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
  it.for(
    entries.flatMap((entry) => [
      { entry, githubActions: false },
      { entry, githubActions: true },
    ]),
  )(
    "$entry preserves real oxlint warning/error exits (GitHub Actions: $githubActions)",
    ({ entry, githubActions }, { signal }) =>
      fixture.run(async () => {
        const { root, env } = await createLintFixture("success", "oxlint", false);
        for (const name of ["oxlint", "tsgolint"]) {
          const bin = path.join(root, "node_modules/.bin", name);
          fs.rmSync(bin, { force: true });
          fs.symlinkSync(path.resolve("node_modules/.bin", name), bin);
        }
        fs.copyFileSync(".oxlintrc.json", path.join(root, ".oxlintrc.json"));
        fs.mkdirSync(path.join(root, "extensions/sample"), { recursive: true });
        fs.writeFileSync(
          path.join(root, "extensions/tsconfig.json"),
          JSON.stringify({ compilerOptions: { strict: true }, include: ["**/*.ts"] }),
        );
        const source = path.join(root, "extensions/sample/oversized.ts");
        const warningSource = `export const values = [\n${"  0,\n".repeat(700)}];\n`;
        const args =
          entry === "run-oxlint.mjs"
            ? ["--tsconfig", "extensions/tsconfig.json", "extensions"]
            : ["--only=extensions", "--extension-stripe=1/1"];
        for (const hasError of [false, true]) {
          const stylelintRunsBefore = readRows<Step>(root, "steps.jsonl").filter(
            (step) => step.step === "stylelint",
          ).length;
          fs.writeFileSync(source, warningSource + (hasError ? "export var legacy = 1;\n" : ""));
          const result = await fixture.track(
            runNodeScript(
              [path.join(root, "scripts", entry), ...args, "--threads=1"],
              { ...env, CI: String(githubActions), GITHUB_ACTIONS: String(githubActions) },
              10_000,
              { cwd: root, signal, requireProcessTreeExit: true },
            ),
          );
          const details = formatShimResult(result);
          expect(result.error, details).toBeUndefined();
          expect(result.status, details).toBe(hasError || !githubActions ? 1 : 0);
          expect(result.stdout, details).toContain("eslint(max-lines)");
          expect(result.stdout, details).toContain(githubActions ? "warning" : "error");
          if (githubActions) {
            expect(result.stdout, details).toContain(hasError ? "1 error" : "0 errors");
            expect(result.stdout, details).toContain("1 warning");
          }
          if (hasError) {
            expect(result.stdout, details).toContain("eslint(no-var)");
          }
          if (entry === "run-lint.mts") {
            expect(
              readRows<Step>(root, "steps.jsonl").filter((step) => step.step === "stylelint"),
            ).toHaveLength(stylelintRunsBefore + (githubActions && !hasError ? 1 : 0));
          }
        }
      }),
  );

  it.for(["exited", "failed"] as const)(
    "reports signal readiness when the command %s before its receipt",
    async (outcome, { signal }) => {
      const failure = outcome === "failed" ? new Error("fixture command failed") : undefined;
      const child = new ChildProcess();
      const kill = vi.spyOn(child, "kill").mockReturnValue(true);
      const run = vi.spyOn(nodeScript, "runNodeScript").mockImplementationOnce(async (...args) => {
        args[3]?.onReady?.(child, () => ({ stdout: "", stderr: "" }));
        return { error: failure, status: failure ? null : 0, stdout: "", stderr: "" };
      });
      try {
        await expect(
          fixture.run(() =>
            runLintFixture("run-lint.mts", "wait", signal, { forwarded: "SIGINT" }),
          ),
        ).rejects.toMatchObject({
          message: expect.stringContaining(`Child ${outcome} before writing`),
          ...(failure ? { cause: failure } : {}),
        });
        expect(kill).not.toHaveBeenCalled();
      } finally {
        run.mockRestore();
        kill.mockRestore();
      }
    },
  );

  it.for(
    entries.flatMap((entry) =>
      (["success", "nonzero", "signal"] as const).map((mode) => ({ entry, mode })),
    ),
  )("$entry reports $mode after joining and releasing artifacts", ({ entry, mode }, { signal }) =>
    fixture.run(async () => {
      const { result, details, steps, trailers } = await runLintFixture(entry, mode, signal);
      const code = mode === "success" ? 0 : mode === "signal" ? 143 : 7;
      expect(result.status, details).toBe(code);
      const lint = steps.find((step) => step.step === "oxlint");
      expect(lint, details).toMatchObject({ owned: true });
      if (mode === "success") {
        expect(steps.find((step) => step.step === "prepare")?.args, details).toEqual([
          "--mode=package-boundary",
        ]);
      }
      if (entry !== "run-oxlint.mjs") {
        expect(lint!.claims).toHaveLength(1);
      }
      if (mode === "success" && entry === "run-lint.mts") {
        expect(steps.map((step) => step.step)).toEqual(["i18n", "prepare", "oxlint", "stylelint"]);
      }
      expect(result.stderr.match(/FAILED \(exit/g) ?? []).toHaveLength(code ? 1 : 0);
      const tool = entry === "run-lint.mts" ? "lint" : "oxlint";
      expect(trailers, details).toEqual(
        code
          ? [{ text: `[${tool}] FAILED (exit ${code})`, owned: false, claims: [], live: [] }]
          : [],
      );
      if (code) {
        expect(result.stderr.trim().split("\n").at(-1)).toBe(`[${tool}] FAILED (exit ${code})`);
        expect(result.stderr).not.toContain("[oxlint:extensions] finished");
      }
    }),
  );

  it.for(["run-oxlint-shards.mts", "run-lint.mts"] as const)(
    "%s reports one timeout after the owned child drains",
    (entry, { signal }) =>
      fixture.run(async () => {
        const { result, details, trailers } = await runLintFixture(entry, "wait", signal, {
          timeout: true,
        });
        expect(result.status, details).toBe(124);
        expect(result.stderr).toContain("timed out");
        expect(result.stderr).toContain("drained:extensions:SIGTERM");
        expect(trailers, details).toEqual([
          {
            text: `[${entry === "run-lint.mts" ? "lint" : "oxlint"}] FAILED (exit 124)`,
            owned: false,
            claims: [],
            live: [],
          },
        ]);
      }),
  );

  it.for(entries)(
    "%s reports preparation exceptions after releasing ownership",
    (entry, { signal }) =>
      fixture.run(async () => {
        const { result, details, steps, trailers } = await runLintFixture(entry, "throw", signal, {
          phase: "prepare",
        });
        expect(result.status, details).toBe(1);
        expect(result.stderr).toContain("fixture preparation failure");
        expect(steps.some((step) => step.step === "oxlint")).toBe(false);
        expect(trailers, details).toEqual([
          {
            text: `[${entry === "run-lint.mts" ? "lint" : "oxlint"}] FAILED (exit 1)`,
            owned: false,
            claims: [],
            live: [],
          },
        ]);
      }),
  );

  it.for(["run-oxlint-shards.mts", "run-lint.mts"] as const)(
    "%s joins parallel siblings before one final failure",
    (entry, { signal }) =>
      fixture.run(async () => {
        const { result, details, steps, trailers } = await runLintFixture(
          entry,
          "nonzero",
          signal,
          { parallel: true },
        );
        expect(result.status, details).toBe(7);
        expect(
          steps
            .filter((step) => step.step === "oxlint")
            .map((step) => step.shard)
            .toSorted(),
        ).toEqual(["core", "extensions", "scripts"]);
        expect(trailers, details).toEqual([
          {
            text: `[${entry === "run-lint.mts" ? "lint" : "oxlint"}] FAILED (exit 7)`,
            owned: false,
            claims: [],
            live: [],
          },
        ]);
        expect(result.stderr.match(/FAILED \(exit/g)).toHaveLength(1);
      }),
  );

  it.for([
    ...entries.flatMap((entry) =>
      (["SIGINT", "SIGTERM"] as const).map((forwarded) => ({ entry, phase: "oxlint", forwarded })),
    ),
    ...["i18n", "prepare", "stylelint"].flatMap((phase) =>
      (["SIGINT", "SIGTERM"] as const).map((forwarded) => ({
        entry: "run-lint.mts" as const,
        phase,
        forwarded,
      })),
    ),
  ])(
    "$entry forwards $forwarded during $phase and reports cancellation",
    ({ entry, phase, forwarded }, { signal }) =>
      fixture.run(async () => {
        const { result, details, trailers } = await runLintFixture(entry, "wait", signal, {
          phase,
          forwarded,
        });
        const code = forwarded === "SIGINT" ? 130 : 143;
        expect(result.status, details).toBe(code);
        expect(result.stderr).toContain(
          `drained:${phase === "oxlint" ? "extensions" : phase}:${forwarded}`,
        );
        const trailer = `[${entry === "run-lint.mts" ? "lint" : "oxlint"}] FAILED (exit ${code})`;
        expect(trailers, details).toEqual([{ text: trailer, owned: false, claims: [], live: [] }]);
        expect(result.stderr.trim().split("\n").at(-1)).toBe(trailer);
      }),
  );

  it.for(["i18n", "stylelint"])("complete lint reports a $0 failure once", (phase, { signal }) =>
    fixture.run(async () => {
      const { result, details, trailers } = await runLintFixture(
        "run-lint.mts",
        "nonzero",
        signal,
        { phase },
      );
      expect(result.status, details).toBe(7);
      expect(trailers, details).toEqual([
        { text: "[lint] FAILED (exit 7)", owned: false, claims: [], live: [] },
      ]);
      expect(result.stderr.match(/FAILED \(exit/g)).toHaveLength(1);
    }),
  );

  it.for(["run-oxlint-shards.mts", "run-lint.mts"] as const)(
    "%s reports after retaining uncertain artifact ownership",
    (entry, { signal }) =>
      fixture.run(async () => {
        // Inject only an uncertainty receipt; the fixture has no escaped/unowned process.
        const { result, details, trailers } = await runLintFixture(entry, "unjoined", signal, {
          phase: "prepare",
        });
        expect(result.status, details).toBe(1);
        expect(result.stderr).toContain("fixture cleanup unverified");
        expect(result.stderr).toContain("child cleanup unverified; retained");
        expect(trailers, details).toEqual([
          {
            text: `[${entry === "run-lint.mts" ? "lint" : "oxlint"}] FAILED (exit 1)`,
            owned: true,
            claims: [],
            live: [],
          },
        ]);
      }),
  );
});
