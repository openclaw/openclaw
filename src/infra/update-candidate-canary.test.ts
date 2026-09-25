import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { formatCliFailureLines, formatCliJsonFailure } from "../cli/failure-output.js";
import { createInvalidConfigError } from "../config/io.invalid-config.js";
import * as diskSpace from "./disk-space.js";
import * as readiness from "./update-candidate-canary-readiness.test-support.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  completeCanaryCommand,
  createCanarySnapshotResult,
  FakeChild,
  renderSteps,
  stubHealthyGateway,
} from "./update-candidate-canary.test-support.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  writeUpdatePostInstallDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "./update-doctor-result.js";
import {
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
} from "./update-post-core-context.js";
import { renderUpdateRunReport, updateRunReportInputFromResult } from "./update-run-report.js";
import { updateRunStepsFromResultStep } from "./update-run-step.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), snapshot: vi.fn(), signal: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) =>
  (await import("./update-candidate-canary-mocks.test-support.js")).mockCanaryChildProcesses(
    await importOriginal<typeof import("node:child_process")>(),
    mocks.spawn,
  ),
);
vi.mock("../process/exec.js", async (importOriginal) => {
  const { mockCanarySnapshotCommands } =
    await import("./update-candidate-canary-mocks.test-support.js");
  return mockCanarySnapshotCommands(
    await importOriginal<typeof import("../process/exec.js")>(),
    mocks.snapshot,
  );
});
vi.mock("../process/kill-tree.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../process/kill-tree.js")>()),
  signalProcessTree: mocks.signal,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let root: string;
let nextPid = 41_000;
const children = new Map<number, FakeChild>();
let candidateConfig: Record<string, unknown>;
let childEnv: NodeJS.ProcessEnv;
let pluginErrors = false;
let pluginInventory: unknown;
let runtimeError = false;
let runtimeContract: unknown;
let databasePath: string | undefined;

function canaryStateOptions(timeoutMs?: number) {
  return { root, stateDir: root, config: {}, env: {}, timeoutMs };
}

beforeEach(async () => {
  vi.clearAllMocks();
  pluginErrors = false;
  pluginInventory = undefined;
  runtimeError = false;
  runtimeContract = { state: 2, agent: 3 };
  databasePath = undefined;
  root = path.join(await fs.realpath(tempDirs.make("canary-unit-")), "candidate");
  await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
    createCanarySnapshotResult(options.input, databasePath),
  );
  mocks.spawn.mockImplementation(
    (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      childEnv = options.env;
      if (args.includes("gateway")) {
        const raw = readFileSync(options.env.OPENCLAW_CONFIG_PATH!, "utf8");
        candidateConfig = JSON.parse(raw) as Record<string, unknown>;
      } else {
        completeCanaryCommand(child, args, () => ({
          pluginInventory,
          pluginErrors,
          runtimeContract,
          runtimeError,
          lintReport: { ok: true, checksRun: 1, findings: [], warnings: [] },
        }));
      }
      return child;
    },
  );
  mocks.signal.mockImplementation(
    (pid: number, _signal: string, options: { onComplete?: () => void }) => {
      children.get(pid)?.emit("close", 0);
      options.onComplete?.();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  children.clear();
});

describe("update candidate canary", () => {
  readiness.registerCanaryReadinessBudgetTests(() => root, mocks);
  it("records a typed capacity refusal before notifying the snapshot failure", async () => {
    const capacity = vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: 0,
      totalBytes: 1024,
    }));
    const onStep = vi.fn();
    try {
      const env = { TMPDIR: "/synthetic/tmp" };
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(), env, onStep });
      expect(result).toMatchObject({ status: "error", phase: "snapshot" });
      const failed = result.steps.at(-1);
      expect(failed).toMatchObject({
        name: "candidate-state-snapshot",
        exitCode: 1,
        snapshotCapacity: {
          reason: "snapshot-capacity-insufficient",
          selection: null,
        },
      });
      expect(
        failed?.snapshotCapacity?.candidates.map((candidate) => candidate.availableBytes),
      ).toEqual([0, 0, 0]);
      expect(onStep).toHaveBeenCalledExactlyOnceWith(failed);
      expect(mocks.snapshot).not.toHaveBeenCalled();
      expect(mocks.spawn).not.toHaveBeenCalled();
    } finally {
      capacity.mockRestore();
    }
  });

  it("keeps snapshot and validation source selection inside the candidate", async () => {
    stubHealthyGateway();
    const servingRoot = path.join(root, "installed");
    const env = { OPENCLAW_DEV_SOURCE_ROOT: servingRoot };
    const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(3000), env });
    expect(result.status).toBe("ok");
    expect(mocks.snapshot.mock.calls[0]?.[1].baseEnv.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0);
    for (const call of mocks.spawn.mock.calls) {
      expect(call[2].env.OPENCLAW_DEV_SOURCE_ROOT).toBe(root);
    }
    expect(env.OPENCLAW_DEV_SOURCE_ROOT).toBe(servingRoot);
  });

  it("classifies a deadline before teardown when SIGTERM closes the child with zero", async () => {
    let now = 2_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    stubHealthyGateway();
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      childEnv = options.env;
      queueMicrotask(() => {
        child.stderr.write(
          formatCliFailureLines({
            title: "The CLI command failed.",
            error: new Error("Health unavailable\nDistinct connection detail"),
            env: {},
          }).join("\n") + "\n",
        );
      });
      now += 899;
      return child;
    });
    try {
      const result = await validateUpdateCandidateCanary(canaryStateOptions(1_000));
      expect(result).toMatchObject({ status: "error", phase: "doctor" });
      expect(result.logTail.join("\n")).toContain("checks phase timed out");
      expect(result.steps.at(-1)).toMatchObject({ exitCode: null, termination: "timeout" });
      expect(result.steps.at(-1)?.stderrTail).toContain("checks phase timed out");
      const detail = updateRunStepsFromResultStep(result.steps.at(-1)!).at(-1)?.detail;
      expect(detail).toContain("Distinct connection detail");
      expect(detail).toContain("checks phase timed out");
      const report = renderUpdateRunReport(
        updateRunReportInputFromResult({ ...result, mode: "git", root }),
      );
      expect(report.markdown).toContain("checks phase timed out");
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves the runtime validation budget after a snapshot exceeds five minutes", async () => {
    databasePath = path.join(root, "snapshot-budget.sqlite");
    await fs.writeFile(databasePath, "");
    await fs.truncate(databasePath, 32 * 1024 ** 2);
    const now = Date.now.bind(Date);
    let snapshotElapsed = 0;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + snapshotElapsed);
    const snapshot = mocks.snapshot.getMockImplementation()!;
    mocks.snapshot.mockImplementation(async (command, options: { input: string }) => {
      const request: unknown = JSON.parse(options.input);
      if (isRecord(request) && request.mode === "snapshot") {
        snapshotElapsed = 300_001;
      }
      return snapshot(command, options);
    });
    stubHealthyGateway();
    try {
      const result = await validateUpdateCandidateCanary(canaryStateOptions(30_000));
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      expect(result.durationMs).toBeGreaterThanOrEqual(300_001);
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "candidate-gateway-startup", exitCode: 0 }),
      );
      expect(result.logTail.join("\n")).toContain("readyz: ready");
      await expect(fs.access(childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each([
    [0, undefined, "error"],
    [2 * 1024 ** 3, undefined, "ok"],
    [2 * 1024 ** 3, 30 * 60_000, "error"],
  ] as const)(
    "derives validation time from %i state bytes while honoring an explicit %s ms deadline",
    async (sqliteBytes, timeoutMs, expectedStatus) => {
      databasePath = path.join(root, "runtime-budget.sqlite");
      await fs.writeFile(databasePath, "");
      await fs.truncate(databasePath, sqliteBytes);
      const now = Date.now.bind(Date);
      let doctorElapsed = 0;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now() + doctorElapsed);
      mocks.spawn.mockImplementationOnce(
        (_command: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
          const child = new FakeChild(nextPid++);
          children.set(child.pid, child);
          childEnv = options.env;
          doctorElapsed = 31 * 60_000;
          queueMicrotask(() => child.emit("close", 0));
          return child;
        },
      );
      stubHealthyGateway();
      try {
        const result = await validateUpdateCandidateCanary(canaryStateOptions(timeoutMs));
        expect(result.steps[0]?.snapshotCapacity?.sqliteBytes).toBe(sqliteBytes);
        expect(result.status, result.logTail.join("\n")).toBe(expectedStatus);
        expect(result.phase).toBe(expectedStatus === "ok" ? "readiness" : "doctor");
        if (expectedStatus === "error") {
          expect(result.logTail.join("\n")).toContain("deadline exceeded");
        } else {
          expect(result.steps).toContainEqual(
            expect.objectContaining({ name: "candidate-doctor", exitCode: 0 }),
          );
          expect(result.logTail.join("\n")).toContain("readyz: ready");
        }
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each([false, true])(
    "identifies legacy Doctor writes even if later validation fails (%s)",
    async (failsValidation) => {
      runtimeError = failsValidation;
      mocks.spawn.mockImplementationOnce(
        (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          expect(args).toContain("doctor");
          const child = new FakeChild(nextPid++);
          children.set(child.pid, child);
          const configPath = options.env.OPENCLAW_CONFIG_PATH;
          if (!configPath) {
            throw new Error("Missing rehearsal config");
          }
          void fs
            .readFile(configPath, "utf8")
            .then(async (raw) => {
              const config: unknown = JSON.parse(raw);
              if (!isRecord(config)) {
                throw new Error("Invalid rehearsal fixture");
              }
              config.meta = { lastTouchedVersion: "2026.9.4" };
              config.wizard = { lastRunCommand: "doctor" };
              config.plugins = { entries: { openai: { enabled: true } } };
              await fs.writeFile(configPath, JSON.stringify(config));
              child.emit("close", 0);
            })
            .catch((error: unknown) => child.emit("error", error));
          return child;
        },
      );
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
      expect(result.status).toBe(failsValidation ? "error" : "ok");
      expect(result.doctorConfigWrites).not.toBe(true);
      expect(result.doctorConfigChanges).toEqual(
        ["meta", "plugins", "wizard"].map((key) => ({ kind: "key", key })),
      );
    },
  );
  it.each([
    {
      label: "advisory",
      receipt: createDeferredConfiguredPluginRepairDoctorResult([
        "Deferred configured plugin repair.",
      ]),
      exitCode: 86,
      expectedStatus: "ok",
    },
    {
      label: "error",
      receipt: {
        status: "error" as const,
        failureFacts: [
          {
            check: "core/doctor/runtime-tool-schemas",
            code: "doctor-failed",
            affectedKey: "mcp.servers",
            message: "connect ECONNREFUSED",
          },
        ],
      },
      exitCode: 1,
      expectedStatus: "error",
    },
  ])(
    "preserves classified Doctor $label and its receipt evidence",
    async ({ receipt, exitCode, expectedStatus }) => {
      mocks.spawn.mockImplementationOnce(
        (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          expect(args).toContain("doctor");
          const child = new FakeChild(nextPid++);
          children.set(child.pid, child);
          const resultPath = options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
          if (!resultPath) {
            throw new Error("Missing candidate Doctor receipt");
          }
          void writeUpdatePostInstallDoctorResult({ resultPath, result: receipt }).then(
            () => child.emit("close", exitCode),
            (error: unknown) => child.emit("error", error),
          );
          return child;
        },
      );
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
      expect(result.status).toBe(expectedStatus);
      const step = result.steps.find((entry) => entry.name === "candidate-doctor");
      expect(step?.exitCode).toBe(exitCode);
      if (receipt.status === "advisory") {
        expect(step?.advisory).toEqual({
          kind: "recoverable-maintenance",
          message: receipt.advisory.details.join("\n"),
        });
      } else {
        expect(step?.advisory).toBeUndefined();
      }
      expect(step?.failureFacts).toEqual(receipt.failureFacts);
    },
  );
  it.each([
    {
      label: "plugin load failure",
      inventory: { plugins: [{ id: "fixture", status: "error" }] },
      proceeds: true,
    },
    {
      label: "attributed registry failure",
      inventory: {
        plugins: [],
        registry: {
          diagnostics: [{ pluginId: "fixture", level: "error", message: "Plugin unavailable" }],
        },
      },
      proceeds: true,
    },
    {
      label: "unattributed registry failure",
      inventory: {
        plugins: [],
        registry: { diagnostics: [{ level: "error", message: "Duplicate plugin registration" }] },
      },
      proceeds: false,
      failureMessage: "Duplicate plugin registration",
    },
    {
      label: "malformed plugin inventory",
      inventory: { plugins: [{ status: "error" }] },
      proceeds: false,
      failureMessage: "invalid inventory",
    },
  ])(
    "handles $label before proving core readiness",
    async ({ inventory, proceeds, failureMessage }) => {
      pluginInventory = inventory;
      stubHealthyGateway();

      const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));

      expect(result.status).toBe(proceeds ? "ok" : "error");
      expect(result.phase).toBe(proceeds ? "readiness" : "plugins");
      if (failureMessage) {
        expect(result.steps.at(-1)?.failureFacts?.[0]?.message).toContain(failureMessage);
      }
      expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("gateway"))).toBe(proceeds);
      if (proceeds) {
        expect(result.steps).toContainEqual(
          expect.objectContaining({
            name: "candidate-plugins",
            exitCode: 0,
            stdoutTail: 'Plugin "fixture" could not be loaded during the update preview.',
          }),
        );
      }
    },
  );

  it("keeps verified readiness and records a warning when rehearsal cleanup fails", async () => {
    stubHealthyGateway();
    const remove = fs.rm.bind(fs);
    let retained: string | undefined;
    const denial = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (
        typeof target === "string" &&
        path.basename(target).startsWith("openclaw-update-canary-")
      ) {
        retained = target;
        throw new Error("synthetic cleanup permission denied");
      }
      return remove(target, options);
    });
    const onStep = vi.fn();
    try {
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(3000), onStep });
      expect(result.status).toBe("ok");
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "candidate-gateway-startup", exitCode: 0 }),
      );
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "candidate-state-cleanup",
          advisory: expect.objectContaining({
            message: expect.stringContaining("synthetic cleanup permission denied"),
          }),
        }),
      );
      expect(onStep).toHaveBeenCalledWith(result.steps.at(-1));
      expect(result.steps.at(-1)?.advisory?.message).toContain(retained);
    } finally {
      denial.mockRestore();
      if (retained) {
        await remove(retained, { recursive: true, force: true });
      }
    }
  });
  it.each([undefined, "unknown-owned-v2"])(
    "keeps unsupported checkpoint capability out of admission (%s)",
    async (candidateMutation) => {
      runtimeContract = {
        state: 2,
        agent: 3,
        executorDelegation: "pid-start-v1",
        candidateMutation,
      };
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
      expect(result.status).toBe("ok");
      expect(result.candidateSchemaVersions).toEqual({ state: 2, agent: 3 });
      expect(result).not.toHaveProperty("checkpointContinuation");
    },
  );
  it("reports unavailable validation when the candidate predates the migration-continuation contract", async () => {
    await fs.rm(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"));
    stubHealthyGateway();
    const onStep = vi.fn();
    const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(3_000), onStep });
    expect(result).toMatchObject({ status: "ok", phase: "runtime" });
    expect(result.candidateSchemaVersions).toBeUndefined();
    expect(result).not.toHaveProperty("checkpointContinuation");
    expect(result.steps).toEqual([
      expect.objectContaining({
        name: "candidate-recovery",
        exitCode: null,
        stdoutTail: "This version uses the current updater to finish installation",
      }),
    ]);
    expect(onStep).toHaveBeenCalledWith(result.steps[0]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rehearses private state, observes readiness, and joins child close after tree signals", async () => {
    runtimeContract = {
      state: 2,
      agent: 3,
      executorDelegation: "pid-start-v1",
      candidateMutation: "checkpoint-owned-v1",
    };
    const requests: string[] = [];
    const completed: Array<{ name: string; argv: string[] }> = [];
    let startupCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        requests.push(new URL(url).pathname);
        if (url.endsWith("startupz")) {
          startupCalls += 1;
          return Response.json({ status: startupCalls === 1 ? "starting" : "started" });
        }
        return Response.json({ ready: true });
      }),
    );
    const original = {
      gateway: { port: 18789 },
      mcp: { apps: { enabled: true, sandboxPort: 18790 } },
      cron: { enabled: true },
      agents: {
        entries: { main: { workspace: "/original/workspace", agentDir: "/original/agent" } },
      },
    };
    const result = await validateUpdateCandidateCanary({
      ...canaryStateOptions(3_000),
      config: original,
      env: {
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: path.join(root, "live-sentinel.json"),
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: path.join(root, "live-result.json"),
        [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: path.join(root, "live-config.json"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: path.join(root, "live-doctor-result.json"),
        OPENCLAW_SYSTEMD_UNIT: "source-gateway.service",
        CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
      },
      onStep: (step) => {
        completed.push({ name: step.name, argv: [...(mocks.spawn.mock.calls.at(-1)?.[1] ?? [])] });
      },
    });
    expect(result.status).toBe("ok");
    expect(result.candidateSchemaVersions).toEqual({ state: 2, agent: 3 });
    expect(result.steps[0]?.snapshotCapacity).toMatchObject({
      sqliteBytes: 0,
      pluginBytes: 0,
      reason: "state-volume",
      selection: { kind: "state-volume" },
    });
    expect(result).not.toHaveProperty("checkpointContinuation");
    expect(result.steps.map((step) => step.name)).toEqual([
      "candidate-state-snapshot",
      "candidate-doctor",
      "candidate-doctor-lint",
      "candidate-config",
      "candidate-plugins",
      "candidate-recovery",
      "candidate-gateway-startup",
    ]);
    expect(completed.map((step) => step.name)).toEqual(result.steps.map((step) => step.name));
    expect(completed.map((step) => step.argv.slice(1, 3))).toEqual([
      [],
      ["doctor", "--fix"],
      ["doctor", "--lint"],
      ["config", "validate"],
      ["plugins", "list"],
      ["--check"],
      ["gateway", "run"],
    ]);
    expect(requests).toEqual(["/startupz", "/startupz", "/readyz"]);
    expect(childEnv.OPENCLAW_STATE_DIR).not.toBe(root);
    expect(childEnv).toMatchObject({
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_NO_AUTO_UPDATE: "1",
      CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
    });
    for (const key of [
      CONTROL_PLANE_UPDATE_SENTINEL_META_ENV,
      POST_CORE_UPDATE_RESULT_PATH_ENV,
      POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
      "OPENCLAW_UPDATE_RUN_HANDOFF",
      "OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH",
      "OPENCLAW_SYSTEMD_UNIT",
    ]) {
      expect(childEnv[key]).toBeUndefined();
    }
    expect(mocks.spawn.mock.calls.find(([, args]) => args.includes("--check"))?.[1]).toEqual([
      path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"),
      "--check",
    ]);
    expect(candidateConfig).toMatchObject({
      cron: { enabled: false },
      gateway: { bind: "loopback" },
      mcp: { apps: { enabled: false } },
    });
    expect(result.listenerIsolation).toEqual({
      gateway: { host: "127.0.0.1", port: expect.any(Number) },
      mcpAppSandbox: "disabled",
    });
    expect(candidateConfig.gateway).toMatchObject({ port: result.listenerIsolation?.gateway.port });
    expect(original.mcp.apps).toEqual({ enabled: true, sandboxPort: 18790 });
    expect(original.cron.enabled).toBe(true);
    const gatewayPid = [...children.keys()].at(-1)!;
    expect(
      mocks.signal.mock.calls.filter(([pid]) => pid === gatewayPid).map(([, signal]) => signal),
    ).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result.logTail.join("\n")).toContain("startupz: started");
    await expect(fs.access(childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["lint", "startup", "startup-multiline", "config", "multiline", "envelope", "compact"])(
    "retains the CLI reason when %s exits before its report",
    async (scenario) => {
      const phase = scenario.startsWith("startup")
        ? "startup"
        : scenario === "config"
          ? "config"
          : "lint";
      const spawnNormally = mocks.spawn.getMockImplementation()!;
      mocks.spawn.mockImplementation((command, args: string[], options) => {
        if (
          !args.includes({ lint: "--lint", startup: "--update-canary", config: "validate" }[phase])
        ) {
          return spawnNormally(command, args, options);
        }
        const error = scenario.endsWith("multiline")
          ? createInvalidConfigError(
              "/fixture/openclaw.json",
              `- gateway.port: invalid ${"x".repeat(160)} token=synthetic-secret\n- gateway.host: unknown`,
            )
          : new Error("Unable to resolve health API token=synthetic-secret");
        if (scenario === "startup-multiline") {
          throw error;
        }
        const child = new FakeChild(nextPid++);
        queueMicrotask(() => {
          if (phase === "config") {
            child.stdout.write(
              JSON.stringify({
                ok: false,
                error: { message: "OpenClaw config is invalid" },
                valid: false,
                issues: [
                  { path: "gateway.port", message: "Expected number; token=synthetic-secret" },
                ],
              }),
            );
          }
          if (["envelope", "compact"].includes(scenario)) {
            child.stdout.write(
              JSON.stringify(
                formatCliJsonFailure(error, { argv: [], env: {} }),
                null,
                scenario === "compact" ? undefined : 2,
              ) + "\n",
            );
          }
          child.stderr.write(
            formatCliFailureLines({ title: "The CLI command failed.", error, env: {} }).join("\n") +
              "\n",
          );
          if (["lint", "startup", "config"].includes(scenario)) {
            child.stderr.write(
              Array.from({ length: 60 }, (_, index) => `cleanup ${index}\n`).join(""),
            );
          }
          child.emit("close", 1);
        });
        return child;
      });
      const env = { API_TOKEN: "synthetic-secret" };
      const result = await validateUpdateCandidateCanary({ ...canaryStateOptions(3_000), env });
      expect(result).toMatchObject({ status: "error", phase });
      const failed = result.steps.at(-1)!;
      expect(failed.failureFacts?.[0]?.message).toContain(
        phase === "config"
          ? "Expected number"
          : scenario.endsWith("multiline")
            ? "Invalid config"
            : "Unable to resolve health API",
      );
      if (!["lint", "config"].includes(scenario)) {
        const output = renderSteps([failed]);
        if (scenario.endsWith("multiline")) {
          expect(output).toContain("gateway.port: invalid");
          expect(output).toContain("gateway.host: unknown");
          expect(updateRunStepsFromResultStep(failed).map((step) => step.detail)).toContainEqual(
            expect.stringContaining(
              scenario === "multiline" ? "gateway.port: invalid" : "Invalid config",
            ),
          );
        } else {
          const report = renderUpdateRunReport(
            updateRunReportInputFromResult({ ...result, mode: "git", root }),
          );
          for (const text of [output, report.markdown]) {
            expect(text.match(/Unable to resolve health API/gu)).toHaveLength(1);
          }
          expect(result.logTail.join("\n")).toContain("Unable to resolve health API");
        }
      }
      if (phase === "config") {
        expect(failed.failureFacts?.[0]?.affectedKey).toBe("gateway.port");
      }
      expect(JSON.stringify(result)).not.toContain("synthetic-secret");
    },
  );

  it.each(["snapshot", "doctor", "plugins", "runtime", "readiness"] as const)(
    "records the %s outcome and cleans private state",
    async (failure) => {
      pluginErrors = failure === "plugins";
      runtimeError = failure === "runtime";
      if (failure === "snapshot") {
        const snapshot = mocks.snapshot.getMockImplementation()!;
        mocks.snapshot.mockImplementation(async (command, options: { input: string }) => {
          const request: unknown = JSON.parse(options.input);
          if (isRecord(request) && request.mode === "inventory") {
            return snapshot(command, options);
          }
          const result = createCanarySnapshotResult(options.input, databasePath);
          return { ...result, code: 1, stdout: "", stderr: "snapshot rejected" };
        });
      }
      if (failure === "doctor") {
        mocks.spawn.mockImplementationOnce(() => {
          const child = new FakeChild(nextPid++);
          queueMicrotask(() => {
            child.stderr.write(
              Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n"),
            );
            child.emit("close", 1);
          });
          return child;
        });
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) =>
          Response.json({ status: "started" }, { status: url.endsWith("readyz") ? 503 : 200 }),
        ),
      );
      const result = await validateUpdateCandidateCanary(canaryStateOptions(250));
      expect(result.status).toBe(failure === "readiness" ? "ok" : "error");
      expect(result.phase).toBe(failure);
      if (failure === "plugins") {
        expect(renderSteps(result.steps)).toContain("incompatible plugin");
      }
      if (failure === "readiness") {
        readiness.expectCanaryReadinessWarning(result.steps.at(-1), "readyz", 503);
      }
      expect(result.steps.some((step) => step.exitCode !== 0)).toBe(true);
      expect(result.logTail.length).toBeLessThanOrEqual(40);
      expect(result.durationMs).toBeLessThan(1_000);
      if (failure === "snapshot") {
        expect(mocks.spawn).not.toHaveBeenCalled();
      } else {
        expect(mocks.signal).toHaveBeenCalled();
      }
      const snapshotInput = JSON.parse(mocks.snapshot.mock.calls.at(-1)![1].input) as {
        targetStateDir: string;
      };
      await expect(fs.access(snapshotInput.targetStateDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("refuses a candidate that cannot keep Doctor away from managed services", async () => {
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.4.1" }));
    const result = await validateUpdateCandidateCanary(canaryStateOptions());
    expect(result.status).toBe("error");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("drains a cancelled validation child before deleting its private state", async () => {
    const controller = new AbortController();
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      const child = new FakeChild(nextPid++);
      children.set(child.pid, child);
      childEnv = options.env;
      queueMicrotask(() => controller.abort(new Error("repair deadline")));
      return child;
    });
    const options = { ...canaryStateOptions(3_000), signal: controller.signal };
    const result = await validateUpdateCandidateCanary(options);
    expect(result.status).toBe("error");
    expect(mocks.spawn).toHaveBeenCalledOnce();
    expect(mocks.signal.mock.calls.map(([, signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(fs.access(childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a zero-exit continuation worker without its compiled schema contract before boot", async () => {
    runtimeContract = null;
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    expect(result.steps.at(-1)).toMatchObject({
      name: "candidate-recovery",
      exitCode: 1,
    });
    expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("--update-canary"))).toBe(false);
  });

  it("aborts further validation and removes private state when recording a step fails", async () => {
    await expect(
      validateUpdateCandidateCanary({
        ...canaryStateOptions(3_000),
        onStep: () => {
          throw new Error("ledger unavailable");
        },
      }),
    ).rejects.toThrow("ledger unavailable");
    expect(mocks.spawn).not.toHaveBeenCalled();
    const snapshotInput = JSON.parse(mocks.snapshot.mock.calls.at(-1)![1].input) as {
      targetStateDir: string;
    };
    await expect(fs.access(snapshotInput.targetStateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([0, 1])("bounds multibyte stdout at the byte ceiling plus %i", async (overflow) => {
    runtimeError = true;
    const baseSpawn = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("plugins")) {
        return baseSpawn(command, args, options);
      }
      const child = new FakeChild(nextPid++);
      const json = JSON.stringify({ plugins: [], padding: "é".repeat(500_000) });
      const bytes = Buffer.from(
        json + " ".repeat(1024 * 1024 + overflow - Buffer.byteLength(json)),
      );
      queueMicrotask(() => {
        child.stdout.write(bytes.subarray(0, 600_000));
        child.stdout.end(bytes.subarray(600_000));
        child.emit("close", 0);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result).toMatchObject({ status: "error", phase: overflow ? "plugins" : "runtime" });
  });

  it("preserves split UTF-8 diagnostics and final unterminated lines on both pipes", async () => {
    const expected = ["stdout 診断: café 🦞", "stderr 診断: café 🦞"];
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeChild(nextPid++);
      queueMicrotask(() => {
        for (const [index, stream] of [child.stdout, child.stderr].entries()) {
          // Real pipe chunks may end inside a code point; EOF need not follow a newline.
          const bytes = Buffer.from(`${expected[index]}\r\n${expected[index]} final`);
          for (const byte of bytes) {
            stream.write(Buffer.from([byte]));
          }
          stream.end();
        }
        child.emit("close", 1);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result.status).toBe("error");
    for (const line of expected) {
      expect(result.logTail).toContain(line);
      expect(result.logTail).toContain(`${line} final`);
      expect(result.steps.at(-1)?.stderrTail).toContain(`${line}\n`);
      expect(result.steps.at(-1)?.stderrTail).toContain(`${line} final`);
    }
  });

  it("omits the entire oversized log line across chunks while preserving following diagnostics", async () => {
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeChild(nextPid++);
      queueMicrotask(() => {
        child.stderr.write("x".repeat(70_000));
        child.stderr.write("synthetic-sensitive-suffix\nfollowing-safe-line\n");
        child.emit("close", 1);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary(canaryStateOptions(3_000));
    expect(result.status).toBe("error");
    expect(result.logTail.join("\n")).not.toContain("synthetic-sensitive-suffix");
    expect(result.logTail).toContain("following-safe-line");
    expect(result.steps.at(-1)?.stderrTail).toContain("following-safe-line");
  });
});
