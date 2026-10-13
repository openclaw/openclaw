import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeExecApprovalsConfigRow } from "../../infra/exec-approvals-sqlite.js";
import * as stateReads from "../../state/openclaw-state-db-readonly.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { observeMainThreadSql } from "../../test-utils/main-thread-sql-spies.test-support.js";
import { withPreparedToolConstruction } from "../tool-construction-preparation.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import { callInProcessGatewayTool } from "./in-process-gateway.js";
import { createOpenClawDelegateToolsForRunAsync } from "./openclaw-delegate-tool.js";

// mock-isolation: Observe delegation authority without dispatching to a live Gateway.
vi.mock("./in-process-gateway.js", () => ({ callInProcessGatewayTool: vi.fn() }));

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("OPENCLAW_TEST_FAST", "0");
});

function construct(assertCurrent?: () => void) {
  return withPreparedToolConstruction(
    { tools: { exec: { host: "gateway", mode: "full" } } },
    { assertCurrent },
    (shared) =>
      createOpenClawDelegateToolsForRunAsync(
        {
          config: shared.config,
          sessionAgentId: "main",
          runSessionKey: "agent:main:delegate-preparation",
        },
        shared,
      ),
  );
}

it("reads fresh delegation policy without caller-thread SQL and retains the captured store", async () => {
  const root = tempDirs.make("openclaw-delegate-exec-");
  const source = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
  for (const security of ["full", "deny", "full"] as const) {
    writeExecApprovalsConfigRow({ db: source.db, file: { version: 1, defaults: { security } } });
    vi.stubEnv("OPENCLAW_STATE_DIR", root);
    const calls = observeMainThreadSql();
    const pending = construct();
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-foreign-delegate-exec-"));
    const [tool] = await pending;
    expect(tool?.description).toContain(
      security === "full" ? "without asking for approval" : "Changes wait for the user to approve",
    );
    vi.mocked(callInProcessGatewayTool).mockImplementation(async () => {
      expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(security === "full");
      return { reply: "Done.", sessionId: "delegate" };
    });
    await tool!.execute("delegate-policy", { message: "Synthetic repair." });
    calls.expectIdle();
    calls.restore();
  }
});

it("requires approval when the reader fails instead of falling back to host SQL", async () => {
  const root = tempDirs.make("openclaw-delegate-exec-failure-");
  vi.stubEnv("OPENCLAW_STATE_DIR", root);
  const source = openOpenClawStateDatabase();
  writeExecApprovalsConfigRow({
    db: source.db,
    file: { version: 1, defaults: { security: "full" } },
  });
  vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockRejectedValue(
    new Error("synthetic approval reader unavailable"),
  );
  const calls = observeMainThreadSql();
  const [tool] = await construct();
  expect(tool?.description).toContain("Changes wait for the user to approve");
  vi.mocked(callInProcessGatewayTool).mockImplementation(async () => {
    expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(false);
    return { reply: "Approval required.", sessionId: "delegate" };
  });
  await tool!.execute("delegate-unavailable", { message: "Synthetic repair." });
  calls.expectIdle();
});

it("rejects a construction whose source authority ends during preparation", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-delegate-exec-revoked-"));
  let current = true;
  const pending = construct(() => {
    if (!current) {
      throw new Error("synthetic source revoked");
    }
  });
  current = false;
  await expect(pending).rejects.toThrow("synthetic source revoked");
  expect(callInProcessGatewayTool).not.toHaveBeenCalled();
});
