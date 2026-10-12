import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
} from "../flows/doctor-health-contributions.test-support.js";
import * as runtimeGuard from "../infra/runtime-guard.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { statusCommand } from "./status.command.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
}));
const runtime = createTestRuntime();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

vi.mock("../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));
vi.mock("../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: mocks.readCommand }),
}));
vi.mock("../daemon/runtime-paths.js", () => ({
  resolveNodeRuntimeInfo: mocks.resolveNodeRuntimeInfo,
}));
vi.mock("./status-json-command.ts", () => ({
  assertStatusUsageAgentScope: () => {},
  runStatusJsonCommand: async () => {},
}));

function mockCliRuntime(version: string, text = true) {
  vi.spyOn(runtimeGuard, "detectRuntime").mockResolvedValue({
    kind: "node",
    version,
    execPath: "/fixture/node",
    pathEnv: "/fixture",
    hasNodeSqlite: true,
    sqliteVersion: "3.53.4",
    sqliteProbe: { available: true, version: "3.53.4", text, blob: true, json: true },
  });
}

function useInvalidConfig() {
  const stateDir = tempDirs.make("openclaw-doctor-node-note-");
  const configPath = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { mode: 42 } }));
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readCommand.mockResolvedValue({
    programArguments: ["/fixture/node", "openclaw.mjs", "gateway"],
  });
  mocks.resolveNodeRuntimeInfo.mockResolvedValue({
    status: "unsupported",
    version: "22.23.2",
    sqliteVersion: "3.50.2",
    nodeSharedSqlite: false,
  });
  mockCliRuntime("26.8.1");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Node runtime diagnostics command surfaces", () => {
  it.each(["invalid config", "snapshot failure"])(
    "renders informational Node findings without a missing fix hint after %s",
    async (failure) => {
      useInvalidConfig();
      const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      mockCliRuntime("24.15.0");
      if (failure === "snapshot failure") {
        vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
          throw new Error("No space left for private snapshot");
        });
      }
      try {
        expect(
          await runDoctorLintCli(runtime, {
            severityMin: "info",
            ...(failure === "snapshot failure" ? { updateReadiness: "post-plugin" } : {}),
          }),
        ).toBe(1);
        expect(runtime.error).toHaveBeenCalledWith(
          expect.stringContaining(
            failure === "snapshot failure"
              ? "No space left for private snapshot"
              : "config file exists but does not parse cleanly",
          ),
        );
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("Node 24.15.0:"));
        expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("nvm install 26"));
        expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("undefined"));
      } finally {
        if (originalIsTTY) {
          Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
        } else {
          Reflect.deleteProperty(process.stdout, "isTTY");
        }
      }
    },
  );

  it("keeps Node repair guidance visible when config validation fails", async () => {
    useInvalidConfig();
    mockCliRuntime("22.23.2", false);
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      expect(await runDoctorLintCli(runtime, { json: true })).toBe(1);
      const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
      expect(payload.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ checkId: "core/doctor/final-config-validation" }),
          expect.objectContaining({
            checkId: "core/doctor/node-runtime",
            fixHint: expect.stringContaining("nvm install 26"),
          }),
        ]),
      );
    } finally {
      stdout.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("registers canonical Doctor findings for CLI and recorded service runtimes", async () => {
    mockCliRuntime("26.0.0", false);
    const checks = await resolveDoctorContributionHealthChecks();
    const check = checks.find((entry) => entry.id === "core/doctor/node-runtime");
    expect(check).toBeDefined();
    const findings = await check?.detect({ mode: "doctor", cfg: {}, runtime, env: {} });
    expect(findings).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("26.0.0"),
        fixHint: expect.stringContaining("nvm install 26"),
      }),
      expect.objectContaining({
        source: "gateway-service",
        message: expect.stringContaining("22.23.2"),
        fixHint: expect.stringContaining("nvm install 26"),
      }),
    ]);
  });

  it.each([
    ["24.19.0", "2026-10-19T23:59:59.999Z", null, null],
    ["24.19.0", "2026-10-20T00:00:00.000Z", "info", "maintenance mode"],
    ["25.9.0", "2026-03-31T23:59:59.999Z", null, null],
    ["25.9.0", "2026-04-01T00:00:00.000Z", "info", "maintenance mode"],
    ["25.9.0", "2026-05-31T23:59:59.999Z", "info", "maintenance mode"],
    ["25.9.0", "2026-06-01T00:00:00.000Z", "warning", "end-of-life on 2026-06-01"],
    ["26.8.1", "2027-10-19T23:59:59.999Z", null, null],
    ["26.8.1", "2027-10-20T00:00:00.000Z", "info", "maintenance mode"],
  ] as const)("reports admitted Node %s lifecycle at %s", async (version, date, severity, text) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(date));
    mockCliRuntime(version);
    mocks.readCommand.mockResolvedValue(null);
    const check = (await resolveDoctorContributionHealthChecks()).find(
      (candidate) => candidate.id === "core/doctor/node-runtime",
    );
    const findings = await check?.detect({ mode: "doctor", cfg: {}, runtime, env: {} });
    const lifecycle = findings?.filter((finding) => finding.message.includes("upstream"));
    expect(lifecycle).toEqual(
      text === null
        ? []
        : [expect.objectContaining({ severity, message: expect.stringContaining(text) })],
    );
  });

  it("keeps lifecycle advice out of healthy upgrade lint checks", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    mockCliRuntime("24.19.0");
    mocks.readCommand.mockResolvedValue(null);
    const check = (await resolveDoctorContributionHealthChecks()).find(
      (candidate) => candidate.id === "core/doctor/node-runtime",
    );
    expect(await check?.detect({ mode: "lint", cfg: {}, runtime, env: {} })).toEqual([]);
  });

  it.each([
    ["standalone", {}, true],
    ["swap", { OPENCLAW_UPDATE_IN_PROGRESS: "1" }, false],
    ["convergence", { OPENCLAW_UPDATE_POST_CORE_CONVERGENCE: "1" }, false],
    ["shipped parent", { OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1" }, false],
  ] as const)(
    "keeps registered Node advice scoped to %s Doctor",
    async (_posture, env, advisory) => {
      for (const key of [
        "OPENCLAW_UPDATE_IN_PROGRESS",
        "OPENCLAW_UPDATE_POST_CORE_CONVERGENCE",
        "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE",
      ]) {
        vi.stubEnv(key, undefined);
      }
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2028-04-30T00:00:00Z"));
      mockCliRuntime("24.19.0");
      mocks.readCommand.mockResolvedValue(null);
      const contribution = resolveDoctorHealthContributions().find(
        (entry) => entry.id === "doctor:node-runtime",
      );
      expect(contribution).toBeDefined();
      const ctx = createDoctorHealthFlowContext({ runtime, env });
      await contribution!.run(ctx);
      expect(ctx.updateWarnings ?? []).toEqual(
        advisory ? [expect.stringContaining("upstream end-of-life on 2028-04-30")] : [],
      );
    },
  );

  it("retains Gateway compatibility warnings during updater Doctor", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2028-04-30T00:00:00Z"));
    mockCliRuntime("24.19.0");
    const contribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:node-runtime",
    );
    const ctx = createDoctorHealthFlowContext({
      runtime,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
    });
    await contribution!.run(ctx);
    expect(ctx.updateWarnings).toEqual([
      expect.stringContaining("Gateway service Node 22.23.2 is unsupported"),
    ]);
  });

  it("does not add lifecycle advice to healthy status JSON", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-20T00:00:00Z"));
    mockCliRuntime("24.19.0");
    mocks.readCommand.mockResolvedValue(null);
    await statusCommand({ json: true }, runtime);
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("keeps the recorded service findings while running under Bun", async () => {
    vi.mocked(runtimeGuard.detectRuntime).mockResolvedValue({
      kind: "bun",
      version: "1.4.0",
      execPath: "/fixture/bun",
      pathEnv: "/fixture",
      hasNodeSqlite: true,
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    });
    const check = (await resolveDoctorContributionHealthChecks()).find(
      (candidate) => candidate.id === "core/doctor/node-runtime",
    );
    expect(await check?.detect({ mode: "doctor", cfg: {}, runtime, env: {} })).toEqual([
      expect.objectContaining({ source: "gateway-service", severity: "warning" }),
    ]);
  });

  it("renders an admitted out-of-table service runtime as information", async () => {
    mocks.readCommand.mockResolvedValue({ programArguments: ["/fixture/node", "gateway"] });
    mocks.resolveNodeRuntimeInfo.mockResolvedValue({
      status: "supported",
      version: "24.15.0",
      note: "Node 24.15.0: unsupported version, capability check passed.",
    });
    await statusCommand({ json: true }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("[info] Node 24.15.0:"));
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("[warning]"));
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("undefined"));
  });

  it("reports an uninspectable service without claiming its Node is unsupported", async () => {
    mocks.resolveNodeRuntimeInfo.mockResolvedValue({
      status: "probe-failed",
      error: new Error("unavailable"),
    });
    await statusCommand({ json: true }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("could not be inspected"));
    expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("is unsupported"));
  });
});
