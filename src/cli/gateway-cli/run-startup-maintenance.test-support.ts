import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, type Mock } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  AgentDatabaseAdmissionError,
  createAgentDatabaseInspectionRefusal,
} from "../../state/agent-database-admission.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { getFreePort } from "../../test-utils/ports.js";
import type { GatewayLoopParams } from "./run-cleanup-receipt.test-support.js";

export function registerGatewayStartupMaintenanceTests({
  configState,
  runGatewayCli,
  runGatewayLoop,
  startGatewayServer,
  runtimeErrors,
  triageAfterFailure,
  parkCurrentLaunchAgentForMaintenance,
}: {
  configState: { snapshot: Record<string, unknown> };
  runGatewayCli: (argv: string[]) => Promise<void>;
  runGatewayLoop: Mock<(params: GatewayLoopParams) => Promise<void>>;
  startGatewayServer: Mock<(port: number, options?: unknown) => Promise<unknown>>;
  runtimeErrors: string[];
  triageAfterFailure: Mock;
  parkCurrentLaunchAgentForMaintenance: Mock;
}): void {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it("prints agent recovery instead of a generic Doctor repair for corrupt startup admission", async () => {
    configState.snapshot = {
      config: { gateway: { port: await getFreePort() } },
      exists: false,
      sourceConfig: {},
      valid: true,
    };
    const cause = Object.assign(new Error("file is not a database"), {
      code: "ERR_SQLITE_ERROR",
      errcode: 26,
    });
    const failure = new AgentDatabaseAdmissionError(
      createAgentDatabaseInspectionRefusal({
        agentId: "main",
        paths: ["/synthetic/openclaw-agent.sqlite"],
        reason: cause.message,
        cause,
      }),
    );
    startGatewayServer.mockRejectedValueOnce(failure);
    await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
      "__exit__:78",
    );
    expect(runtimeErrors.join("\n")).toContain(
      "openclaw doctor --session-sqlite recover --session-sqlite-agent main",
    );
    expect(runtimeErrors.join("\n")).not.toContain("doctor --fix");
  });

  it("retains the actual legacy-session refusal without triage on restart", async () => {
    const root = tempDirs.make("gateway-legacy-refusal-");
    const storePath = path.join(root, "sessions.json");
    const original = '{"main":{"sessionId":"legacy","updatedAt":1}}';
    await fs.writeFile(storePath, original);
    try {
      const { assertSessionStoreMigrationComplete } =
        await import("../../config/sessions/startup-migration.js");
      let refusal: unknown;
      try {
        assertSessionStoreMigrationComplete({ cfg: {}, targets: [{ storePath }] });
      } catch (error) {
        refusal = error;
      }
      expect(refusal).toBeInstanceOf(Error);
      const message = (refusal as Error).message;
      expect(message).toBe(
        `Legacy session store requires migration: ${storePath}. Run "openclaw doctor --fix" against the same state/config before starting OpenClaw.`,
      );
      const failure = refusal;
      runGatewayLoop.mockImplementationOnce(async (params: GatewayLoopParams) => {
        await params.beginBoot?.(1000);
        await params.onRestartStartupFailure?.(failure, new AbortController().signal);
        throw failure;
      });
      await withEnvAsync({ CODEX_THREAD_ID: undefined }, async () => {
        await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
          "__exit__:78",
        );
      });
      expect(triageAfterFailure).not.toHaveBeenCalled();
      expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
      expect(runtimeErrors.join("\n")).toContain(message);
      expect(await fs.readFile(storePath, "utf8")).toBe(original);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("exits 78 when the only startup blocker is legacy workspace setup state", async () => {
    const workspaceDir = tempDirs.make("gateway-workspace-refusal-");
    const source = path.join(workspaceDir, "openclaw-workspace-state.json");
    const original = JSON.stringify({ version: 1, setupCompletedAt: new Date().toISOString() });
    await fs.writeFile(source, original);
    try {
      const { assertWorkspaceStateMigrationReady } =
        await import("../../agents/workspace-legacy-state.js");
      startGatewayServer.mockImplementationOnce(async () => {
        assertWorkspaceStateMigrationReady({ workspaceDirs: [workspaceDir] });
        throw new Error("Legacy workspace setup state was unexpectedly accepted");
      });
      await expect(runGatewayCli(["gateway", "run", "--allow-unconfigured"])).rejects.toThrow(
        "__exit__:78",
      );
      expect(parkCurrentLaunchAgentForMaintenance).toHaveBeenCalledOnce();
      expect(triageAfterFailure).not.toHaveBeenCalled();
      expect(runtimeErrors.join("\n")).toMatch(/gateway stop.*doctor --fix.*gateway start/s);
      expect(await fs.readFile(source, "utf8")).toBe(original);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });
}
