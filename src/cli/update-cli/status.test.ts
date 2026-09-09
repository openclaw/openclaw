import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runtimeGuard from "../../infra/runtime-guard.js";
import { readUpdateRunDriver } from "../../infra/update-run-driver.js";
import {
  createUpdateRun,
  getUpdateRun,
  recordUpdateRunPhase,
} from "../../infra/update-run-ledger.js";
import { ABANDONED_UPDATE_RUN_MS } from "../../infra/update-run-timeouts.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { updateStatusCommand } from "./status.js";

const runtime = vi.hoisted(() => ({
  log: vi.fn(),
  error: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
}));

const service = vi.hoisted(() => ({
  readCommand: vi.fn(),
  resolveNodeRuntimeInfo: vi.fn(),
}));

vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ readCommand: service.readCommand }),
}));
vi.mock("../../daemon/runtime-paths.js", () => ({
  resolveNodeRuntimeInfo: service.resolveNodeRuntimeInfo,
}));
vi.mock("../../config/paths.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../config/paths.js")>()),
  isDefaultInstallIdentity: () => true,
}));

vi.mock("../../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../runtime.js")>()),
  defaultRuntime: runtime,
}));
vi.mock("../../config/config.js", () => ({
  readSourceConfigBestEffort: async () => ({}),
}));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: async () => ({
    root: "/fixture/openclaw",
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.2" },
  }),
}));
vi.mock("./shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./shared.js")>()),
  resolveUpdateRoot: async () => "/fixture/openclaw",
}));

const tempDirs = createTempDirTracker();

beforeEach(() => {
  vi.clearAllMocks();
  service.readCommand.mockResolvedValue(null);
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-update-status-"));
});

describe("update status Node runtime findings", () => {
  it.each(["cli", "service"])(
    "renders admitted %s runtime information without a missing hint",
    async (source) => {
      if (source === "cli") {
        vi.spyOn(runtimeGuard, "detectRuntime").mockReturnValue({
          kind: "node",
          version: "24.15.0",
          execPath: "/fixture/node",
          pathEnv: "/fixture",
          hasNodeSqlite: true,
          sqliteVersion: "3.53.4",
          sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
        });
      } else {
        service.readCommand.mockResolvedValue({ programArguments: ["/fixture/node", "gateway"] });
        service.resolveNodeRuntimeInfo.mockResolvedValue({
          status: "supported",
          version: "24.15.0",
          note: "Node 24.15.0: unsupported version, capability probe passed.",
        });
      }
      await updateStatusCommand({});
      expect(runtime.log).toHaveBeenCalledWith(expect.stringContaining("capability probe passed"));
      expect(runtime.log).not.toHaveBeenCalledWith(undefined);
    },
  );

  it.each([
    { version: "22.23.2", source: "cli" },
    { version: "26.0.0", source: "cli" },
    { version: "22.23.2", source: "gateway-service" },
    { version: "26.0.0", source: "gateway-service" },
  ])(
    "reports unsupported $source Node $version with recovery instructions",
    async ({ version, source }) => {
      vi.stubGlobal("process", {
        ...process,
        versions: { ...process.versions, node: source === "cli" ? version : "26.8.1" },
      });
      if (source === "cli") {
        vi.spyOn(runtimeGuard, "detectRuntime").mockReturnValue({
          kind: "node",
          version,
          execPath: "/fixture/node",
          pathEnv: "/fixture",
          hasNodeSqlite: true,
          sqliteVersion: "3.53.4",
          sqliteProbe: { available: true, version: "3.53.4", text: false, blob: true, json: true },
        });
      }
      if (source === "gateway-service") {
        service.readCommand.mockResolvedValue({
          programArguments: ["/fixture/node", "openclaw.mjs", "gateway"],
        });
        service.resolveNodeRuntimeInfo.mockResolvedValue({
          status: "unsupported",
          version,
          sqliteVersion: "3.50.2",
          nodeSharedSqlite: false,
        });
      }

      await updateStatusCommand({ json: true });

      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          runtimeFindings: [
            expect.objectContaining({
              source,
              message: expect.stringContaining(version),
              requirement: expect.stringContaining(">=24.16.0 <25, or >=26.1.0"),
              fixHint: expect.stringContaining("https://openclaw.ai/install.sh"),
            }),
          ],
        }),
      );
      await updateStatusCommand({});
      const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
      expect(output).toContain(version);
      expect(output).toContain("npm");
      expect(output).toContain("nvm install 26");
    },
  );

  it("does not report a supported CLI or recorded service Node", async () => {
    vi.stubGlobal("process", { ...process, versions: { ...process.versions, node: "26.8.1" } });
    service.readCommand.mockResolvedValue({
      programArguments: ["/fixture/node", "openclaw.mjs", "gateway"],
    });
    service.resolveNodeRuntimeInfo.mockResolvedValue({
      status: "supported",
      version: "26.8.1",
      sqliteVersion: "3.53.0",
      nodeSharedSqlite: false,
    });
    await updateStatusCommand({ json: true });
    expect(runtime.writeJson.mock.lastCall?.[0].runtimeFindings ?? []).toEqual([]);
  });
});

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  tempDirs.cleanup();
});

describe("update status abandoned-run reporting", () => {
  it.each([true, false])(
    "gives explicit recovery guidance for stale identityless history (JSON: %s)",
    async (json) => {
      const now = Date.now();
      const lastActivity = now - ABANDONED_UPDATE_RUN_MS - 10;
      vi.spyOn(Date, "now").mockReturnValue(lastActivity);
      const recorded = createUpdateRun({ trigger: "control-ui", before: { version: "2026.9.2" } });
      vi.mocked(Date.now).mockReturnValue(now);

      await updateStatusCommand({ json });

      const guidance = `no activity since ${new Date(lastActivity).toISOString()}; if no update is running, run \`openclaw update repair\` or start a new \`openclaw update\``;
      expect(getUpdateRun(recorded.runId)).toEqual(recorded);
      if (json) {
        expect(runtime.writeJson).toHaveBeenCalledWith(
          expect.objectContaining({
            activeRun: recorded,
            staleRun: { runId: recorded.runId, guidance },
          }),
        );
        expect(runtime.writeJson.mock.lastCall?.[0]).not.toHaveProperty("abandonedRun");
      } else {
        const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
        expect(output).toContain(guidance);
        expect(output).not.toContain("update in progress:");
      }
    },
  );

  it.each([true, false])("reports abandonment read-only (JSON: %s)", async (json) => {
    const now = Date.now();
    const driver = readUpdateRunDriver();
    if (!driver) {
      throw new Error("Test process identity is unavailable");
    }
    vi.spyOn(Date, "now").mockReturnValue(now - ABANDONED_UPDATE_RUN_MS - 10);
    const created = createUpdateRun({
      trigger: "control-ui",
      before: { version: "2026.9.2" },
      // This live PID has a different start identity than the exited driver.
      origin: { driver: { ...driver, startIdentity: String(Number(driver.startIdentity) + 1) } },
    });
    const recorded = recordUpdateRunPhase(created.runId, "staging");
    vi.mocked(Date.now).mockReturnValue(now);

    await updateStatusCommand({ json });

    expect(getUpdateRun(created.runId)).toEqual(recorded);
    if (json) {
      expect(runtime.writeJson).toHaveBeenCalledWith(
        expect.objectContaining({
          activeRun: recorded,
          lastRun: recorded,
          abandonedRun: { runId: created.runId, rule: "inactive-driver-dead" },
        }),
      );
    } else {
      const output = runtime.log.mock.calls.map(([line]) => String(line)).join("\n");
      expect(output).toContain("Abandoned update detected;");
      expect(output).toContain("openclaw update repair");
      expect(output).not.toContain("update in progress:");
      expect(output).not.toContain("update failed:");
    }
  });
});
