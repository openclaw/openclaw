import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { validateUpdateCandidateCanary } from "./update-candidate-canary.js";
import {
  completeCanaryCommand,
  createCanarySnapshotResult,
  FakeChild,
  stubHealthyGateway,
} from "./update-candidate-canary.test-support.js";
import { updateRunStepsFromResultStep, updateRunWarningMessages } from "./update-run-step.js";

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
let lintReport: { ok: boolean; checksRun: number; findings: unknown[]; warnings: unknown[] };

function canaryStateOptions(timeoutMs?: number) {
  return { root, stateDir: root, config: {}, env: {}, timeoutMs };
}

beforeEach(async () => {
  vi.clearAllMocks();
  lintReport = { ok: true, checksRun: 1, findings: [], warnings: [] };
  root = path.join(await fs.realpath(tempDirs.make("canary-lint-")), "candidate");
  await fs.mkdir(path.join(root, "dist", "infra"), { recursive: true });
  await fs.writeFile(path.join(root, "dist", "index.js"), "");
  await fs.writeFile(path.join(root, "dist", "infra", "update-migrated-finalize.worker.js"), "");
  await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "2026.9.1" }));
  mocks.snapshot.mockImplementation(async (_command, options: { input: string }) =>
    createCanarySnapshotResult(options.input),
  );
  mocks.spawn.mockImplementation((_command: string, args: string[]) => {
    const child = new FakeChild(nextPid++);
    children.set(child.pid, child);
    if (!args.includes("gateway")) {
      completeCanaryCommand(child, args, () => ({
        pluginInventory: undefined,
        pluginErrors: false,
        runtimeContract: { state: 2, agent: 3 },
        runtimeError: false,
        lintReport,
      }));
    }
    return child;
  });
  mocks.signal.mockImplementation(
    (pid: number, _signal: string, options: { onComplete?: () => void }) => {
      children.get(pid)?.emit("close", 0);
      options.onComplete?.();
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const child of children.values()) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
  children.clear();
});

describe("update candidate Doctor lint", () => {
  it.each([false, true])(
    "retains posture warnings without admitting blocking lint errors (blocking: %s)",
    async (blocking) => {
      lintReport = {
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
      const result = await validateUpdateCandidateCanary(canaryStateOptions());
      expect(result.status).toBe(blocking ? "error" : "ok");
      if (blocking) {
        expect(result).toMatchObject({ phase: "lint", reason: "doctor-failed" });
      }
      expect(
        updateRunWarningMessages(result.steps.flatMap(updateRunStepsFromResultStep)),
      ).toContainEqual(
        expect.stringContaining("Open group policy permits mention-gated requests."),
      );
      expect(
        result.steps.find((step) => step.name === "Checking update health")?.doctorLintFindings,
      ).toEqual([...lintReport.findings, ...lintReport.warnings]);
    },
  );
  it("treats an older candidate's security policy error as a named advisory", async () => {
    const finding = {
      checkId: "core/doctor/security",
      severity: "error",
      message: 'Discord DMs are open: dmPolicy="open" allows anyone to DM the bot.',
    };
    lintReport = {
      ok: false,
      checksRun: 1,
      findings: [finding],
      warnings: [],
    };
    stubHealthyGateway();
    const result = await validateUpdateCandidateCanary(canaryStateOptions());
    expect(result.status).toBe("ok");
    const step = result.steps.find((entry) => entry.name === "Checking update health");
    expect(step).toMatchObject({
      exitCode: 1,
      advisory: { kind: "recoverable-maintenance" },
    });
    expect(step?.doctorLintFindings).toEqual([{ ...finding, severity: "warning" }]);
    expect(step?.failureFacts).toBeUndefined();
  });
  it.each([
    { name: "signal", exitCode: null, signal: "SIGTERM", outputLimitExceeded: false },
    { name: "output limit after exit zero", exitCode: 0, signal: null, outputLimitExceeded: true },
    { name: "output limit after exit one", exitCode: 1, signal: null, outputLimitExceeded: true },
  ])("retains physical $name facts without accepting policy output", async (physical) => {
    const spawnNormally = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("--lint")) {
        return spawnNormally(command, args, options);
      }
      const child = Object.assign(new FakeChild(nextPid++), { killed: physical.signal !== null });
      children.set(child.pid, child);
      queueMicrotask(() => {
        child.stdout.write(
          JSON.stringify({
            ok: false,
            checksRun: 1,
            findings: [
              { checkId: "core/doctor/security", severity: "error", message: "DMs are open." },
            ],
          }),
        );
        if (physical.outputLimitExceeded) {
          child.stdout.write("x".repeat(1024 * 1024));
        }
        child.emit("close", physical.exitCode, physical.signal);
      });
      return child;
    });
    const result = await validateUpdateCandidateCanary(canaryStateOptions());
    expect(result).toMatchObject({ status: "error", phase: "lint", reason: "doctor-failed" });
    const step = result.steps.find((entry) => entry.name === "Checking update health")!;
    expect(step).toMatchObject({
      exitCode: physical.exitCode,
      signal: physical.signal,
      killed: physical.signal !== null,
      termination: physical.signal ? "signal" : "exit",
      outputLimitExceeded: physical.outputLimitExceeded,
    });
    expect(step.advisory).toBeUndefined();
    expect(step.doctorLintFindings).toBeDefined();
  });
  it("preserves bounded Doctor findings before the diagnostic log tail", async () => {
    const spawnNormally = mocks.spawn.getMockImplementation()!;
    mocks.spawn.mockImplementation((command, args: string[], options) => {
      if (!args.includes("--lint")) {
        return spawnNormally(command, args, options);
      }
      const child = new FakeChild(nextPid++);
      queueMicrotask(() => {
        child.stdout.write(
          `${JSON.stringify({
            ok: false,
            checksRun: 1,
            findings: [
              ...Array.from({ length: 40 }, (_, index) => ({
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
    const env = { API_TOKEN: "synthetic-canary-secret" };
    const options = { ...canaryStateOptions(3_000), env, onStep };
    const result = await validateUpdateCandidateCanary(options);
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
    const findings = result.steps.at(-1)?.doctorLintFindings;
    expect(findings).toHaveLength(48);
    expect(findings?.map((finding) => finding.checkId)).toEqual([
      ...Array.from({ length: 40 }, (_, index) => `optional.warning.${index}`),
      ...Array.from({ length: 8 }, (_, index) => `config.invalid.${index}`),
    ]);
    expect(findings?.every((finding) => finding.message.length <= 500)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("synthetic-canary-secret");
    expect(JSON.stringify(result)).not.toContain("/Users/synthetic");
    expect(result.logTail.join("\n")).not.toContain("config.invalid.0");
  });
});
