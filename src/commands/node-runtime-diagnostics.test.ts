import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
import * as runtimeGuard from "../infra/runtime-guard.js";
import { runDoctorLintCli } from "./doctor-lint.js";
import { statusCommand } from "./status.command.js";

const mocks = vi.hoisted(() => ({
  readCommand: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
}));
const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));
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
  vi.spyOn(runtimeGuard, "detectRuntime").mockReturnValue({
    kind: "node",
    version,
    execPath: "/fixture/node",
    pathEnv: "/fixture",
    hasNodeSqlite: true,
    sqliteVersion: "3.53.4",
    sqliteProbe: { available: true, version: "3.53.4", text, blob: true, json: true },
  });
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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Node runtime diagnostics command surfaces", () => {
  it.each(["invalid config", "snapshot failure"])(
    "renders informational Node findings without a missing fix hint after %s",
    async (failure) => {
      const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-node-note-"));
      vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
      vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
      const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
      Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
      mockCliRuntime("24.15.0");
      mocks.readConfigFileSnapshot.mockResolvedValue({
        exists: true,
        valid: false,
        config: {},
        issues: [{ path: "gateway.mode", message: "Required" }],
      });
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
        vi.unstubAllEnvs();
        fs.rmSync(stateDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps Node repair guidance visible when config validation fails", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      path: "/tmp/openclaw.json",
      issues: [{ path: "gateway.mode", message: "Required" }],
    });
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
    const findings = await check?.detect({ mode: "lint", cfg: {}, runtime, env: {} });
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

  it("warns about a stale service Node without mixing text into status JSON", async () => {
    await statusCommand({ json: true }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("Gateway service Node 22.23.2"),
    );
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("https://openclaw.ai/install.sh"),
    );
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it.each(["cli", "service"])(
    "renders an admitted out-of-table %s runtime as information",
    async (source) => {
      mocks.readCommand.mockResolvedValue(null);
      if (source === "cli") {
        mockCliRuntime("24.15.0");
      } else {
        mocks.readCommand.mockResolvedValue({ programArguments: ["/fixture/node", "gateway"] });
        mocks.resolveNodeRuntimeInfo.mockResolvedValue({
          status: "supported",
          version: "24.15.0",
          note: "Node 24.15.0: unsupported version, capability probe passed.",
        });
      }
      await statusCommand({ json: true }, runtime);
      expect(runtime.error).toHaveBeenCalledWith(expect.stringContaining("[info] Node 24.15.0:"));
      expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("[warning]"));
      expect(runtime.error).not.toHaveBeenCalledWith(expect.stringContaining("undefined"));
    },
  );

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
