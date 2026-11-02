import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createCliTtyMock } from "../cli/test-runtime-capture.js";
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
const tty = createCliTtyMock([process.stdout]);
const contains = (text: string) => expect.stringContaining(text);
const expectError = (text: string) => expect(runtime.error).toHaveBeenCalledWith(contains(text));
const repairHint = contains("nvm install 26");
const nodeCheck = "core/doctor/node-runtime";

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
  mocks.readCommand.mockResolvedValue({ programArguments: ["/fixture/node"] });
  mocks.resolveNodeRuntimeInfo.mockResolvedValue({
    status: "unsupported",
    version: "22.23.2",
  });
  mockCliRuntime("26.12.1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  tty.restore();
});

it.each(["invalid config", "snapshot failure"])(
  "keeps Node repair hints after %s",
  async (failure) => {
    useInvalidConfig();
    tty.set(true);
    mockCliRuntime("24.15.0");
    if (failure === "snapshot failure") {
      vi.spyOn(fs, "mkdtempSync").mockImplementationOnce(() => {
        throw new Error("No space left for private snapshot");
      });
    }
    expect(
      await runDoctorLintCli(runtime, {
        severityMin: "info",
        ...(failure === "snapshot failure" ? { updateReadiness: "post-plugin" } : {}),
      }),
    ).toBe(1);
    for (const message of [
      failure === "snapshot failure"
        ? "No space left for private snapshot"
        : "config file exists but does not parse cleanly",
      "Node 24.15.0:",
      "nvm install 26",
    ]) {
      expectError(message);
    }
    expect(runtime.error).not.toHaveBeenCalledWith(contains("undefined"));
  },
);

it("keeps repair guidance in JSON despite invalid config", async () => {
  useInvalidConfig();
  mockCliRuntime("26.0.0", false);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runDoctorLintCli(runtime, { json: true })).toBe(1);
  const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
  const expectFinding = (shape: object) =>
    expect(payload.findings).toContainEqual(expect.objectContaining(shape));
  expectFinding({ checkId: "core/doctor/final-config-validation" });
  expectFinding({ checkId: nodeCheck, message: contains("26.0.0"), fixHint: repairHint });
  expectFinding({ source: "gateway-service", message: contains("22.23.2"), fixHint: repairHint });
});

it.each(["unsupported", "probe-failed"] as const)(
  "renders service runtime %s without a misleading diagnosis",
  async (status) => {
    const unsupported = status === "unsupported";
    const info = unsupported
      ? { status, version: "24.22.0" }
      : { status, error: new Error("unavailable") };
    mocks.resolveNodeRuntimeInfo.mockResolvedValue(info);
    await statusCommand({ json: true }, runtime);
    expectError(
      unsupported ? "Gateway service Node 24.22.0 is unsupported." : "could not be inspected",
    );
    for (const message of unsupported ? ["[info]", "undefined"] : ["is unsupported"]) {
      expect(runtime.error).not.toHaveBeenCalledWith(contains(message));
    }
  },
);
