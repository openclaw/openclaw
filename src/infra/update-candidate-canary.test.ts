import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import * as diskSpace from "./disk-space.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  FakeChild,
  stubHealthyGateway,
  useCanaryFixture,
} from "./update-candidate-canary.test-support.js";
import { prepareUpdateCandidateRehearsal } from "./update-candidate-rehearsal.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "./update-control-plane-sentinel.js";
import {
  createDeferredConfiguredPluginRepairDoctorResult,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "./update-doctor-result.js";
import {
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV,
} from "./update-post-core-context.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  snapshot: vi.fn(),
  signal: vi.fn(),
  reap: vi.fn(),
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../process/exec.js", () => ({ runCommandBuffered: mocks.snapshot }));
vi.mock("../process/kill-tree.js", () => ({ signalProcessTree: mocks.signal }));
vi.mock("../process/scoped-child-reaper.js", () => ({
  scheduleAdoptedChildZombieReapAfterExit: mocks.reap,
}));

const fixture = useCanaryFixture(mocks);

describe("update candidate canary", () => {
  it("records a typed capacity refusal before notifying the snapshot failure", async () => {
    const capacity = vi.spyOn(diskSpace, "tryReadDiskSpace").mockImplementation((targetPath) => ({
      targetPath,
      checkedPath: targetPath,
      availableBytes: 0,
      totalBytes: 1024,
    }));
    const onStep = vi.fn();
    try {
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: { TMPDIR: "/synthetic/tmp" },
        onStep,
      });
      expect(result).toMatchObject({ status: "error", phase: "snapshot" });
      const failed = result.steps.at(-1);
      expect(failed).toMatchObject({
        name: "candidate snapshot",
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

  it.each([false, true])(
    "retains posture warnings without admitting blocking lint errors (blocking: %s)",
    async (blocking) => {
      fixture.lintReport = {
        ok: !blocking,
        checksRun: 1,
        findings: blocking
          ? [{ checkId: "core/config", severity: "error", message: "Invalid configuration." }]
          : [],
        warnings: [
          {
            checkId: "core/doctor/security",
            severity: "warning",
            message: "Open group policy permits mention-gated requests.",
          },
        ],
      };
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
      });
      expect(result.status).toBe(blocking ? "error" : "ok");
      if (blocking) {
        expect(result).toMatchObject({ phase: "lint", reason: "doctor-failed" });
      } else {
        expect(
          updateRunWarningMessages(result.steps.flatMap(updateRunStepsFromResultStep)),
        ).toContain("Open group policy permits mention-gated requests.");
      }
    },
  );

  it("keeps snapshot and validation source selection inside the candidate", async () => {
    stubHealthyGateway();
    const servingRoot = path.join(fixture.root, "installed");
    const env = { OPENCLAW_DEV_SOURCE_ROOT: servingRoot };
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env,
      timeoutMs: 3000,
    });
    expect(result.status).toBe("ok");
    expect(mocks.snapshot.mock.calls[0]?.[1].baseEnv.OPENCLAW_DEV_SOURCE_ROOT).toBe(fixture.root);
    expect(mocks.spawn.mock.calls.length).toBeGreaterThan(0);
    for (const call of mocks.spawn.mock.calls) {
      expect(call[2].env.OPENCLAW_DEV_SOURCE_ROOT).toBe(fixture.root);
    }
    expect(env.OPENCLAW_DEV_SOURCE_ROOT).toBe(servingRoot);
  });

  it("classifies a deadline before teardown when SIGTERM closes the child with zero", async () => {
    let now = 2_000_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    stubHealthyGateway();
    mocks.spawn.mockImplementationOnce((_command, _args, options) => {
      const child = new FakeChild(fixture.nextPid++);
      fixture.children.set(child.pid, child);
      fixture.childEnv = options.env;
      now += 899;
      return child;
    });
    try {
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
        timeoutMs: 1_000,
      });
      expect(result).toMatchObject({ status: "error", phase: "doctor" });
      expect(result.logTail.join("\n")).toContain("deadline exceeded");
      expect(result.steps.at(-1)).toMatchObject({ exitCode: 1 });
      expect(result.steps.at(-1)?.stderrTail).toContain("deadline exceeded");
    } finally {
      clock.mockRestore();
    }
  });

  it("preserves the runtime validation budget after a snapshot exceeds five minutes", async () => {
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
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
      });
      expect(result, result.logTail.join("\n")).toMatchObject({ status: "ok", phase: "readiness" });
      expect(result.durationMs).toBeGreaterThanOrEqual(300_001);
      expect(result.steps).toContainEqual(
        expect.objectContaining({ name: "candidate gateway canary", exitCode: 0 }),
      );
      expect(result.logTail.join("\n")).toContain("readyz: ready");
      await expect(fs.access(fixture.childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      clock.mockRestore();
    }
  });

  it.each([false, true])(
    "identifies legacy Doctor writes even if later validation fails (%s)",
    async (failsValidation) => {
      fixture.runtimeError = failsValidation;
      mocks.spawn.mockImplementationOnce(
        (_command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          expect(args).toContain("doctor");
          const child = new FakeChild(fixture.nextPid++);
          fixture.children.set(child.pid, child);
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
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
        timeoutMs: 3000,
      });
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
          const child = new FakeChild(fixture.nextPid++);
          fixture.children.set(child.pid, child);
          const resultPath = options.env[UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV];
          if (!resultPath) {
            throw new Error("Missing candidate Doctor receipt");
          }
          // FakeChild runs in the parent; write its wire receipt without using the parent's tmpdir.
          void fs.writeFile(resultPath, JSON.stringify(receipt), { mode: 0o600, flag: "wx" }).then(
            () => child.emit("close", exitCode),
            (error: unknown) => child.emit("error", error),
          );
          return child;
        },
      );
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
        timeoutMs: 3000,
      });
      expect(result.status).toBe(expectedStatus);
      const step = result.steps.find((entry) => entry.name === "candidate migration rehearsal");
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
      label: "malformed plugin inventory",
      inventory: { plugins: [{ status: "error" }] },
      proceeds: false,
    },
  ])("handles $label before proving core readiness", async ({ inventory, proceeds }) => {
    fixture.pluginInventory = inventory;
    stubHealthyGateway();

    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
      timeoutMs: 3000,
    });

    expect(result.status).toBe(proceeds ? "ok" : "error");
    expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("gateway"))).toBe(proceeds);
    if (proceeds) {
      expect(result.steps).toContainEqual(
        expect.objectContaining({
          name: "candidate plugin resolution",
          exitCode: 0,
          stdoutTail: 'Plugin "fixture" could not be loaded during the update preview.',
        }),
      );
      expect(result.phase).toBe("readiness");
    } else {
      expect(result.phase).toBe("plugins");
    }
  });

  it.each([undefined, "unknown-owned-v2"])(
    "keeps unsupported checkpoint capability out of admission (%s)",
    async (candidateMutation) => {
      fixture.runtimeContract = {
        state: 2,
        agent: 3,
        executorDelegation: "pid-start-v1",
        candidateMutation,
      };
      stubHealthyGateway();
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
        timeoutMs: 3000,
      });
      expect(result.status).toBe("ok");
      expect(result.candidateSchemaVersions).toEqual({ state: 2, agent: 3 });
      expect(result).not.toHaveProperty("checkpointContinuation");
    },
  );

  it("reports unavailable validation when the candidate predates the migration-continuation contract", async () => {
    await fs.rm(path.join(fixture.root, "dist", "infra", "update-migrated-finalize.worker.js"));
    stubHealthyGateway();
    const onStep = vi.fn();
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
      timeoutMs: 3_000,
      onStep,
    });
    expect(result).toMatchObject({ status: "ok", phase: "runtime" });
    expect(result.candidateSchemaVersions).toBeUndefined();
    expect(result).not.toHaveProperty("checkpointContinuation");
    expect(result.steps).toEqual([
      expect.objectContaining({
        name: "candidate migration continuation",
        exitCode: null,
        stdoutTail:
          "candidate predates the migration-continuation contract; finalization runs in the current binary",
      }),
    ]);
    expect(onStep).toHaveBeenCalledWith(result.steps[0]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rehearses and validates only private state before requiring started then ready, and reaps the process group", async () => {
    fixture.runtimeContract = {
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
      root: fixture.root,
      stateDir: fixture.root,
      config: original,
      env: {
        [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: path.join(fixture.root, "live-sentinel.json"),
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: path.join(fixture.root, "live-result.json"),
        [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: path.join(fixture.root, "live-config.json"),
        OPENCLAW_UPDATE_RUN_HANDOFF: "1",
        OPENCLAW_UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH: path.join(
          fixture.root,
          "live-doctor-result.json",
        ),
        OPENCLAW_SYSTEMD_UNIT: "source-gateway.service",
        CUSTOM_PROVIDER_KEY: "synthetic-provider-credential",
      },
      timeoutMs: 3_000,
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
      "candidate snapshot",
      "candidate migration rehearsal",
      "candidate doctor lint",
      "candidate config validation",
      "candidate plugin resolution",
      "candidate migration continuation",
      "candidate gateway canary",
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
    expect(fixture.childEnv.OPENCLAW_STATE_DIR).not.toBe(fixture.root);
    expect(fixture.childEnv).toMatchObject({
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
      expect(fixture.childEnv[key]).toBeUndefined();
    }
    expect(mocks.spawn.mock.calls.find(([, args]) => args.includes("--check"))?.[1]).toEqual([
      path.join(fixture.root, "dist", "infra", "update-migrated-finalize.worker.js"),
      "--check",
    ]);
    expect(fixture.candidateConfig).toMatchObject({
      cron: { enabled: false },
      gateway: { bind: "loopback" },
      mcp: { apps: { enabled: false } },
    });
    expect(result.listenerIsolation).toEqual({
      gateway: { host: "127.0.0.1", port: expect.any(Number) },
      mcpAppSandbox: "disabled",
    });
    expect(fixture.candidateConfig.gateway).toMatchObject({
      port: result.listenerIsolation?.gateway.port,
    });
    expect(original.mcp.apps).toEqual({ enabled: true, sandboxPort: 18790 });
    expect(original.cron.enabled).toBe(true);
    const gatewayPid = [...fixture.children.keys()].at(-1)!;
    expect(
      mocks.signal.mock.calls.filter(([pid]) => pid === gatewayPid).map(([, signal]) => signal),
    ).toEqual(process.platform === "win32" ? ["SIGTERM", "SIGKILL"] : ["SIGTERM"]);
    expect(result.logTail.join("\n")).toContain("startupz: started");
    await expect(fs.access(fixture.childEnv.OPENCLAW_STATE_DIR!)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("reuses caller-owned rehearsal changes across validations until the caller disposes them", async () => {
    const config: OpenClawConfig = { logging: { level: "info" } };
    const observed: Array<{ configPath: string; level: string | undefined }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const configPath = fixture.childEnv.OPENCLAW_CONFIG_PATH!;
        const current = JSON.parse(await fs.readFile(configPath, "utf8")) as OpenClawConfig;
        observed.push({ configPath, level: current.logging?.level });
        return Response.json({ status: "started", ready: true });
      }),
    );
    const rehearsal = await prepareUpdateCandidateRehearsal({
      candidateRoot: fixture.root,
      config,
      stateDir: fixture.root,
      env: {},
      timeoutMs: 3_000,
    });
    try {
      const first = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config,
        env: {},
        rehearsal,
        timeoutMs: 3_000,
      });
      expect(first.status).toBe("ok");
      const copied = JSON.parse(await fs.readFile(rehearsal.configPath, "utf8")) as OpenClawConfig;
      copied.logging = { ...copied.logging, level: "debug" };
      const repairedConfig = JSON.stringify(copied);
      await fs.writeFile(rehearsal.configPath, repairedConfig);
      const second = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config,
        env: {},
        rehearsal,
        timeoutMs: 3_000,
      });
      expect(second.status).toBe("ok");
      expect(observed).toEqual([
        { configPath: rehearsal.configPath, level: "info" },
        { configPath: rehearsal.configPath, level: "info" },
        { configPath: rehearsal.configPath, level: "debug" },
        { configPath: rehearsal.configPath, level: "debug" },
      ]);
      expect(mocks.snapshot).toHaveBeenCalledTimes(2);
      expect(await fs.readFile(rehearsal.configPath, "utf8")).toBe(repairedConfig);
      await expect(fs.access(rehearsal.stateDir)).resolves.toBeUndefined();
    } finally {
      await rehearsal.cleanup();
    }
    await expect(fs.access(rehearsal.stateDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves bounded Doctor findings before the diagnostic log tail", async () => {
    const spawnNormally = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("--lint")) {
        return spawnNormally(command, args, options);
      }
      const child = new FakeChild(fixture.nextPid++);
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            ok: false,
            checksRun: 1,
            findings: [
              ...Array.from({ length: 8 }, (_, index) => ({
                checkId: `optional.warning.${index}`,
                severity: "warning",
                message: "Optional check was skipped.",
              })),
              ...Array.from({ length: 8 }, (_, index) => ({
                checkId: `config.invalid.${index}`,
                severity: "error",
                path: "mcp.servers.example",
                message:
                  "Invalid server at /Users/synthetic/private/config.json token=synthetic-canary-secret",
                requirement: "connect ECONNREFUSED private-host.example:8443",
              })),
            ],
          })}\n`,
        );
        child.stderr.write(Array.from({ length: 60 }, (_, index) => `cleanup ${index}\n`).join(""));
        child.emit("close", 1);
      });
      return child;
    });
    const onStep = vi.fn();
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: { API_TOKEN: "synthetic-canary-secret" },
      timeoutMs: 3_000,
      onStep,
    });
    expect(result).toMatchObject({ status: "error", phase: "lint" });
    expect(result.steps.at(-1)).toMatchObject({
      failureFacts: Array.from({ length: 5 }, (_, index) => ({
        check: `config.invalid.${index}`,
        code: "doctor-failed",
        affectedKey: "mcp.servers.example",
        message: expect.stringContaining("Invalid server"),
      })),
    });
    expect(onStep).toHaveBeenLastCalledWith(result.steps.at(-1));
    expect(result.steps.at(-1)?.failureFacts?.[0]?.message).toContain("ECONNREFUSED");
    expect(JSON.stringify(result)).not.toContain("synthetic-canary-secret");
    expect(JSON.stringify(result)).not.toContain("/Users/synthetic");
    expect(result.logTail.join("\n")).not.toContain("config.invalid.0");
  });

  it.each(["snapshot", "doctor", "plugins", "runtime", "readiness"] as const)(
    "records a failed %s step and cleans private state",
    async (failure) => {
      fixture.pluginErrors = failure === "plugins";
      fixture.runtimeError = failure === "runtime";
      if (failure === "snapshot") {
        const snapshot = mocks.snapshot.getMockImplementation()!;
        mocks.snapshot.mockImplementation(async (command, options: { input: string }) => {
          const request: unknown = JSON.parse(options.input);
          if (isRecord(request) && request.mode === "inventory") {
            return snapshot(command, options);
          }
          return {
            code: 1,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from("snapshot rejected"),
            termination: "exit",
          };
        });
      }
      if (failure === "doctor") {
        mocks.spawn.mockImplementationOnce(() => {
          const child = new FakeChild(fixture.nextPid++);
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
      const result = await validateUpdateCandidateCanary({
        root: fixture.root,
        stateDir: fixture.root,
        config: {},
        env: {},
        timeoutMs: 250,
      });
      expect(result.status).toBe("error");
      expect(result.phase).toBe(failure);
      if (failure === "readiness") {
        expect(result.steps.at(-1)?.name).toBe("candidate gateway canary");
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
    await fs.writeFile(
      path.join(fixture.root, "package.json"),
      JSON.stringify({ version: "2026.4.1" }),
    );
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
    });
    expect(result.status).toBe("error");
    expect(mocks.snapshot).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
  });

  it("rejects a zero-exit continuation worker without its compiled schema contract before boot", async () => {
    fixture.runtimeContract = null;
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
      timeoutMs: 3_000,
    });
    expect(result).toMatchObject({ status: "error", phase: "runtime" });
    expect(result.steps.at(-1)).toMatchObject({
      name: "candidate migration continuation",
      exitCode: 1,
    });
    expect(mocks.spawn.mock.calls.some(([, args]) => args.includes("--update-canary"))).toBe(false);
  });

  it.each([0, 1])("bounds multibyte stdout at the byte ceiling plus %i", async (overflow) => {
    fixture.runtimeError = true;
    const baseSpawn = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("plugins")) {
        return baseSpawn(command, args, options);
      }
      const child = new FakeChild(fixture.nextPid++);
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
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
      timeoutMs: 3_000,
    });
    expect(result).toMatchObject({ status: "error", phase: overflow ? "plugins" : "runtime" });
  });

  it("preserves split UTF-8 diagnostics and final unterminated lines on both pipes", async () => {
    const expected = ["stdout 診断: café 🦞", "stderr 診断: café 🦞"];
    mocks.spawn.mockImplementationOnce(() => {
      const child = new FakeChild(fixture.nextPid++);
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
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
      timeoutMs: 3_000,
    });
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
      const child = new FakeChild(fixture.nextPid++);
      queueMicrotask(() => {
        child.stderr.write("x".repeat(70_000));
        child.stderr.write("synthetic-sensitive-suffix\nfollowing-safe-line\n");
        child.emit("close", 1);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary({
      root: fixture.root,
      stateDir: fixture.root,
      config: {},
      env: {},
      timeoutMs: 3_000,
    });
    expect(result.status).toBe("error");
    expect(result.logTail.join("\n")).not.toContain("synthetic-sensitive-suffix");
    expect(result.logTail).toContain("following-safe-line");
    expect(result.steps.at(-1)?.stderrTail).toContain("following-safe-line");
  });
});
