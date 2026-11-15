import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { scriptModuleEntrypoints } from "../../scripts/script-module-runtime.test-support.mts";
import * as live from "../../scripts/test-live-shard.mts";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { expectNoReaddirSyncDuring } from "../../src/test-utils/fs-scan-assertions.js";
import { awaitGateBeforeSettlement, createDeferred, withinTest } from "../helpers/promise.js";
import {
  isProcessAlive,
  waitForClose,
  waitForProcessExit,
} from "./live-process-fixture.test-support.js";
import { preparedScriptWrapperEnv } from "./prepared-script-wrapper.test-support.js";
import { createScriptTestHarness } from "./test-helpers.js";

const { createTempDir } = createScriptTestHarness();
const ACP_FILE = "src/gateway/gateway-acp-bind.live.test.ts";
const BACKEND_FILE = "src/gateway/gateway-cli-backend.live.test.ts";
const CODEX_FILE = "src/gateway/gateway-codex-harness.live.test.ts";
const REASONING_FILE = "src/agents/openai-reasoning-compat.live.test.ts";
const runtimeEnv = {
  OPENCLAW_DISABLE_BONJOUR: "1",
  OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
  OPENCLAW_LIVE_TEST_QUIET: "0",
  OPENCLAW_LOG_LEVEL: "info",
  OPENCLAW_PLUGIN_LIFECYCLE_TRACE: "1",
};

function expectReport(payload: unknown, reason?: string, files?: string[], env = process.env) {
  expect(live.validateLiveShardReportPayload(payload, files, process.cwd(), env)).toEqual(
    reason ? { ok: false, reason: `Vitest report ${reason}` } : { ok: true },
  );
}

function reportFile(file: string, status: string, assertion = {}) {
  return { name: path.join(process.cwd(), file), assertionResults: [{ status, ...assertion }] };
}

function report(
  numPassedTests: number,
  numTotalTests: number,
  ...testResults: ReturnType<typeof reportFile>[]
) {
  return { numPassedTests, numTotalTests, ...(testResults.length ? { testResults } : {}) };
}

const allFiles = live.collectAllLiveTestFiles();
const preparation = (shard: string) =>
  live.resolveLiveShardPreparation(live.selectLiveShardFiles(shard, allFiles));

it("discovers live tests without scanning source roots in-process", () => {
  expectNoReaddirSyncDuring(() => {
    const files = live.collectAllLiveTestFiles();

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.endsWith(".live.test.ts"))).toBe(true);
  });
});

it("covers every native live test in the release partition", () => {
  const selectedFiles = live.RELEASE_LIVE_TEST_SHARDS.flatMap((shard) =>
    live.selectLiveShardFiles(shard, allFiles),
  );
  expect(allFiles.length).toBeGreaterThan(0);
  expect([...new Set(selectedFiles)].toSorted((a, b) => a.localeCompare(b))).toEqual(allFiles);
});

it.each([
  { alias: "o-z", members: ["o-z-other", "xai"] },
  { alias: "media", members: ["media-audio", "media-music", "media-video"] },
  { alias: "media-music", members: ["media-music-google"] },
])("keeps $alias as the union of its component shards", ({ alias, members }) => {
  const select = (name: string) =>
    live.selectLiveShardFiles(`native-live-extensions-${name}`, allFiles);
  expect(select(alias)).toEqual(members.flatMap(select).toSorted((a, b) => a.localeCompare(b)));
});

it("rejects unknown shard names", () => {
  expect(() => live.selectLiveShardFiles("native-live-missing")).toThrow(
    /Unknown live test shard/u,
  );
});

it("parses list mode and rejects unknown live shard options", () => {
  expect(live.parseLiveShardArgs(["native-live-src-agents", "--list"])).toEqual({
    shard: "native-live-src-agents",
    listOnly: true,
    passthroughArgs: [],
  });

  expect(() => live.parseLiveShardArgs(["--lisst", "native-live-src-agents"])).toThrow(
    /Unknown option: --lisst/u,
  );
});

it("preserves Vitest passthrough args after the live shard separator", () => {
  expect(live.parseLiveShardArgs(["native-live-test", "--", "-t", "smoke"])).toEqual({
    shard: "native-live-test",
    listOnly: false,
    passthroughArgs: ["-t", "smoke"],
  });
  expect(live.buildLiveShardPnpmArgs(["test/foo.live.test.ts"], ["-t", "smoke"])).toEqual([
    "test:live",
    "--",
    "test/foo.live.test.ts",
    "-t",
    "smoke",
  ]);
});

it("adds JSON report evidence without dropping operator output", () => {
  const reportPath = live.buildLiveShardReportPath("native-live-src-agents", {
    OPENCLAW_LIVE_SHARD_REPORT_DIR: ".artifacts/live-proof",
  });

  expect(reportPath).toBe(".artifacts/live-proof/native-live-src-agents.vitest.json");
  expect(live.addLiveShardReportArgs(["-t", "smoke"], reportPath)).toEqual([
    "-t",
    "smoke",
    "--reporter=default",
    "--reporter=json",
    "--outputFile.json=.artifacts/live-proof/native-live-src-agents.vitest.json",
  ]);
  expect(
    live.buildLiveShardPnpmArgs(
      ["src/agents/xai.live.test.ts"],
      live.addLiveShardReportArgs([], reportPath),
    ),
  ).toContain("--reporter=json");
});

it.each([
  ["extensions-o-z-other", "qaRuntime"],
  ["extensions-xai", null],
  ["src-gateway-profiles", "sourcePerformance"],
  ["extensions-openai", "sourcePerformance"],
])("prepares the required runtime for %s", (shard, profile) => {
  expect(preparation(`native-live-${shard}`)).toEqual(
    profile === null
      ? null
      : {
          env: profile === "qaRuntime" ? { OPENCLAW_BUILD_PRIVATE_QA: "1" } : {},
          profile,
          requiredArtifact:
            profile === "qaRuntime"
              ? "dist/extensions/qa-lab/runtime-api.js"
              : "dist/.runtime-postbuildstamp",
          ...(shard === "src-gateway-profiles" ? { runtimeEnv } : {}),
        },
  );
});

it("runs the frozen candidate's available build entrypoint and advertised profile", () => {
  expect(live.resolveLiveShardBuildEntrypoint((file) => file === "scripts/build-all.mts")).toEqual([
    "--import",
    "tsx",
    "scripts/build-all.mts",
  ]);
  expect(live.resolveLiveShardBuildEntrypoint((file) => file === "scripts/build-all.mjs")).toEqual([
    "scripts/build-all.mjs",
  ]);
  expect(() => live.resolveLiveShardBuildEntrypoint(() => false)).toThrow(
    "Live test shard cannot find scripts/build-all.{mts,mjs}",
  );
  expect(
    live.resolveLiveShardBuildProfile(
      "sourcePerformance",
      "Profiles:\n  full\n  sourcePerformance\n",
    ),
  ).toBe("sourcePerformance");
  expect(live.resolveLiveShardBuildProfile("sourcePerformance", "Profiles:\n  full\n")).toBe(
    "full",
  );
});

it.each([
  { payload: report(1, 3), reason: undefined },
  { payload: report(4, 3), reason: "numPassedTests exceeds numTotalTests." },
  { payload: report(0, 3), reason: "has no passing live tests." },
  { payload: { numPassedTests: 0 }, reason: "numTotalTests must be a non-negative integer." },
])("validates live shard report counts: $payload", ({ payload, reason }) =>
  expectReport(payload, reason),
);

it("requires live shard report evidence for each selected file", () => {
  const payload = report(1, 2, reportFile(ACP_FILE, "passed"));

  expectReport(payload, undefined, [ACP_FILE]);
  expectReport(payload, `missing selected live test file evidence: ${BACKEND_FILE}`, [
    ACP_FILE,
    BACKEND_FILE,
  ]);
  expectReport(report(1, 1), "is missing testResults file evidence.", [ACP_FILE]);
});

it("respects explicit opt-in and pass evidence", () => {
  const reviewFile = "test/e2e/crabbox-sandbox.live.test.ts";
  const optInEnv = "OPENCLAW_E2E_CRABBOX";
  const payload = report(
    1,
    2,
    reportFile(REASONING_FILE, "passed"),
    reportFile(reviewFile, "skipped"),
  );
  const expectedFiles = [REASONING_FILE, reviewFile];

  expectReport(payload, undefined, expectedFiles, {});
  expectReport(
    payload,
    `selected live test files had no passing assertions: ${reviewFile}`,
    expectedFiles,
    { [optInEnv]: "1" },
  );
  expectReport(
    report(2, 2, ...expectedFiles.map((file) => reportFile(file, "passed"))),
    undefined,
    expectedFiles,
    { [optInEnv]: "1" },
  );
});

it("does not count disabled opt-in sentinel assertions as live shard proof", () => {
  const payload = report(
    1,
    2,
    reportFile(CODEX_FILE, "passed", {
      ancestorTitles: ["gateway live (Codex harness disabled)"],
      title: "is opt-in",
    }),
    reportFile(BACKEND_FILE, "skipped"),
  );

  expectReport(
    payload,
    "has no enabled selected live test files with passing assertions.",
    [CODEX_FILE, BACKEND_FILE],
    {},
  );
});

it("removes stale live shard reports before running a shard", () => {
  const root = createTempDir("openclaw-live-shard-");
  const reportPath = path.join(root, "stale.vitest.json");
  fs.writeFileSync(reportPath, JSON.stringify({ numPassedTests: 1, numTotalTests: 1 }), "utf8");

  live.removeLiveShardReportFile(reportPath);
  expect(fs.existsSync(reportPath)).toBe(false);
  expect(() => live.removeLiveShardReportFile(reportPath)).not.toThrow();
});

it.each([
  { platform: "darwin" as const, detached: true, override: undefined },
  { platform: "win32" as const, detached: false, override: undefined },
  { platform: "darwin" as const, detached: true, override: runtimeEnv },
])(
  "spawns cleanup-friendly children on $platform ($override)",
  ({ platform, detached, override }) => {
    const env = override ? { OPENCLAW_LOG_LEVEL: "warn", PATH: "/usr/bin" } : { PATH: "/usr/bin" };
    expect(live.buildLiveShardSpawnParams(env, platform, override)).toEqual({
      detached,
      env: { ...(override ? runtimeEnv : {}), PATH: "/usr/bin" },
      stdio: "inherit",
    });
  },
);

it.skipIf(process.platform === "win32")(
  "cleans live shard descendants before forwarding parent SIGTERM",
  async ({ signal }) => {
    const root = fs.mkdtempSync(path.join(tmpdir(), "openclaw-live-shard-signal-"));
    const fakePnpmPath = path.join(root, "pnpm");
    const argsPath = path.join(root, "args.json");
    const pidPaths = ["child.pid", "descendant.pid"].map((name) => path.join(root, name));
    const signaledPath = path.join(root, "signaled");
    let pids: number[] = [];
    let runner: ReturnType<typeof spawn> | undefined;
    let runnerClosed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;

    try {
      writeFakePnpm(fakePnpmPath);
      // Give the real shard selector an APNs-only inventory: readiness must belong
      // to the live-test child, not a build prerequisite of another infra test.
      fs.mkdirSync(path.join(root, "src/infra"), { recursive: true });
      fs.writeFileSync(path.join(root, "src/infra/push-apns-http2.live.test.ts"), "");
      const startedRunner = spawn(
        process.execPath,
        [path.resolve("scripts/test-live-shard.mjs"), "native-live-src-infra"],
        {
          cwd: root,
          env: preparedScriptWrapperEnv(
            [
              [
                new URL("../../scripts/test-live-shard.mts", import.meta.url),
                resolveRuntimeWorkerUrl(scriptModuleEntrypoints.liveShard),
              ],
            ],
            {
              ...process.env,
              OPENCLAW_FAKE_PNPM_ARGS_PATH: argsPath,
              OPENCLAW_FAKE_PNPM_DESCENDANT_PID_PATH: pidPaths[1],
              OPENCLAW_FAKE_PNPM_PID_PATH: pidPaths[0],
              OPENCLAW_FAKE_PNPM_SIGNALED_PATH: signaledPath,
              npm_execpath: fakePnpmPath,
            },
          ),
          stdio: ["ignore", "pipe", "ignore"],
        },
      );

      runner = startedRunner;
      runnerClosed = waitForClose(startedRunner);
      const ready = createDeferred();
      let output = "";
      startedRunner.stdout.on("data", (chunk) => {
        output += String(chunk);
        if (output.includes("fixture pnpm tree ready\n")) {
          ready.resolve();
        }
      });
      await withinTest(
        awaitGateBeforeSettlement(
          ready.promise,
          runnerClosed,
          `timeout waiting for pid in ${pidPaths[1]}`,
        ),
        signal,
      );
      pids = pidPaths.map((file) => Number.parseInt(fs.readFileSync(file, "utf8"), 10));
      expect(JSON.parse(fs.readFileSync(argsPath, "utf8")).slice(0, 3)).toEqual([
        "test:live",
        "--",
        "src/infra/push-apns-http2.live.test.ts",
      ]);

      runner.kill("SIGTERM");

      await expect(withinTest(runnerClosed, signal)).resolves.toEqual({
        code: null,
        signal: "SIGTERM",
      });
      // The fixture writes before exit; the runner joins its child before re-raising.
      expect(fs.readFileSync(signaledPath, "utf8")).toBe("SIGTERM");
      for (const pid of pids) {
        await waitForProcessExit(pid, signal);
      }
    } finally {
      try {
        if (runner?.pid && isProcessAlive(runner.pid)) {
          runner.kill("SIGTERM");
        }
        // Join before removing the receipts needed for cancellation cleanup.
        await runnerClosed;
      } finally {
        // Read durable ownership even when test cancellation interrupted readiness.
        pids = pidPaths.map(
          (file, index) =>
            pids[index] || (fs.existsSync(file) ? Number(fs.readFileSync(file, "utf8")) : 0),
        );
        // A failed shim join must not skip cleanup of already observed descendants.
        for (const pid of pids) {
          if (pid && isProcessAlive(pid)) {
            process.kill(pid, "SIGKILL");
          }
        }
        try {
          await Promise.all(
            pids.filter((pid) => pid > 0).map((pid) => waitForProcessExit(pid, signal)),
          );
        } finally {
          fs.rmSync(root, { force: true, recursive: true });
        }
      }
    }
  },
);

function writeFakePnpm(filePath: string): void {
  fs.writeFileSync(
    filePath,
    `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const fs = require("node:fs");
if (process.argv[2] !== "test:live") throw new Error("Expected the live-test invocation");
fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
const child = spawn(process.execPath, [
  "-e",
  "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready');",
], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
process.on("SIGTERM", () => {
  fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_SIGNALED_PATH, "SIGTERM");
  process.exit(0);
});
fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_DESCENDANT_PID_PATH, String(child.pid));
fs.writeFileSync(process.env.OPENCLAW_FAKE_PNPM_PID_PATH, String(process.pid));
child.once("message", () => process.stdout.write("fixture pnpm tree ready\\n"));
setInterval(() => {}, 1000);
`,
  );
  fs.chmodSync(filePath, 0o755);
}
