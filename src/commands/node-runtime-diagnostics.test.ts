import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveDoctorContributionHealthChecks } from "../flows/doctor-health-contributions.js";
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
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
const contains = (text: string) => expect.stringContaining(text);
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
  vi.unstubAllGlobals();
  if (originalIsTTY) {
    Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
  } else {
    Reflect.deleteProperty(process.stdout, "isTTY");
  }
});

it.each(["invalid config", "snapshot failure"])(
  "keeps Node repair hints after %s",
  async (failure) => {
    useInvalidConfig();
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: true });
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
      expect(runtime.error).toHaveBeenCalledWith(contains(message));
    }
    expect(runtime.error).not.toHaveBeenCalledWith(contains("undefined"));
  },
);

it("keeps repair guidance in JSON despite invalid config", async () => {
  useInvalidConfig();
  mockCliRuntime("22.23.2", false);
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runDoctorLintCli(runtime, { json: true })).toBe(1);
  const payload = JSON.parse(String(stdout.mock.calls.at(-1)?.[0]));
  expect(payload.findings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ checkId: "core/doctor/final-config-validation" }),
      expect.objectContaining({ checkId: nodeCheck, fixHint: repairHint }),
    ]),
  );
});

it("registers CLI and service Node repair findings", async () => {
  mockCliRuntime("26.0.0", false);
  const checks = await resolveDoctorContributionHealthChecks();
  const check = checks.find((entry) => entry.id === nodeCheck);
  const findings = await check?.detect({ mode: "lint", cfg: {}, runtime, env: {} });
  expect(findings).toMatchObject([
    { message: contains("26.0.0"), fixHint: repairHint },
    { source: "gateway-service", message: contains("22.23.2"), fixHint: repairHint },
  ]);
});

it.each([
  [
    { status: "unsupported", version: "24.22.0" },
    "Gateway service Node 24.22.0 is unsupported.",
    ["[info]", "undefined"],
  ],
  [
    { status: "probe-failed", error: new Error("unavailable") },
    "could not be inspected",
    ["is unsupported"],
  ],
] as const)(
  "renders service runtime %j without a misleading diagnosis",
  async (info, present, absent) => {
    mocks.resolveNodeRuntimeInfo.mockResolvedValue(info);
    await statusCommand({ json: true }, runtime);
    expect(runtime.error).toHaveBeenCalledWith(contains(present));
    for (const message of absent) {
      expect(runtime.error).not.toHaveBeenCalledWith(contains(message));
    }
  },
);
