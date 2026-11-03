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

async function expectDelegation(pending: ReturnType<typeof construct>, fullPermission: boolean) {
  const [tool] = await pending;
  expect(tool?.description).toContain(
    fullPermission ? "without asking for approval" : "Changes wait for the user to approve",
  );
  vi.mocked(callInProcessGatewayTool).mockImplementation(async () => {
    expect(getGatewayToolCallerIdentity()?.fullPermission).toBe(fullPermission);
    return { reply: fullPermission ? "Done." : "Approval required.", sessionId: "delegate" };
  });
  await tool!.execute("delegate-policy", { message: "Synthetic repair." });
}

it.each([false, true])(
  "captures delegation policy without caller-thread SQL (reader failure=%s)",
  async (failed) => {
    const root = tempDirs.make("openclaw-delegate-exec-");
    const source = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    if (failed) {
      vi.spyOn(stateReads, "executeExistingOpenClawStateRead").mockRejectedValue(
        new Error("synthetic approval reader unavailable"),
      );
    }
    const policies = failed ? (["full"] as const) : (["full", "deny", "full"] as const);
    for (const security of policies) {
      writeExecApprovalsConfigRow({ db: source.db, file: { version: 1, defaults: { security } } });
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      const calls = observeMainThreadSql();
      const pending = construct();
      if (!failed) {
        vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-foreign-delegate-exec-"));
      }
      await expectDelegation(pending, !failed && security === "full");
      calls.expectIdle();
      calls.restore();
    }
  },
);

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
