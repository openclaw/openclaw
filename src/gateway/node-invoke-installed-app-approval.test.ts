import { expect, test } from "vitest";
import { buildSystemRunApprovalBinding } from "../infra/system-run-approval-binding.js";
import { createTestApprovalManager } from "./exec-approval-manager.test-support.js";
import { sanitizeSystemRunParamsForForwarding } from "./node-invoke-system-run-approval.js";

const client = {
  connId: "conn-1",
  connect: {
    scopes: ["operator.write", "operator.approvals"],
    client: { id: "cli-1", mode: "cli" },
    device: { id: "dev-1" },
  },
};
function expectRejectedForwardingResult(
  result: Awaited<ReturnType<typeof sanitizeSystemRunParamsForForwarding>>,
  code: string,
) {
  expect(result).toMatchObject({ ok: false, details: { code } });
}
function expectAllowOnceForwardingResult(
  result: Awaited<ReturnType<typeof sanitizeSystemRunParamsForForwarding>>,
) {
  expect(result).toMatchObject({
    ok: true,
    params: { approved: true, approvalDecision: "allow-once" },
  });
}

test("binds a real app approval to caller, node, revision and one consumption", async (testContext) => {
  const approvalManager = createTestApprovalManager(testContext);
  const app = { appId: "linux-desktop:fixture.desktop", appRevision: "a".repeat(64) };
  const argv = ["/usr/bin/true"];
  const sessionKey = "agent:main:main";
  const plan = {
    argv,
    commandText: "/usr/bin/true",
    cwd: null,
    agentId: "main",
    sessionKey,
    installedApp: app,
  };
  const record = approvalManager.create(
    {
      host: "node",
      nodeId: "node-1",
      command: plan.commandText,
      systemRunPlan: plan,
      systemRunBinding: buildSystemRunApprovalBinding({
        argv,
        cwd: null,
        agentId: "main",
        sessionKey,
      }).binding,
    },
    60_000,
  );
  record.requestedByDeviceId = "dev-1";
  record.requestedByConnId = "conn-1";
  const pending = (await approvalManager.register(record, 60_000)).decision;
  expect(await approvalManager.resolve(record.id, "allow-once", "operator")).toBe(true);
  await expect(pending).resolves.toBe("allow-once");
  const rawParams = { command: argv, systemRunPlan: plan, runId: record.id, approved: true };
  const base = {
    nodeId: "node-1",
    rawParams,
    client,
    installedApp: app,
    execApprovalManager: approvalManager,
  };
  expectRejectedForwardingResult(
    await sanitizeSystemRunParamsForForwarding({
      ...base,
      client: { ...client, connect: { ...client.connect, device: { id: "other-device" } } },
    }),
    "APPROVAL_DEVICE_MISMATCH",
  );
  expectRejectedForwardingResult(
    await sanitizeSystemRunParamsForForwarding({ ...base, nodeId: "other-node" }),
    "APPROVAL_NODE_MISMATCH",
  );
  for (const installedApp of [
    undefined,
    { ...app, appId: "linux-desktop:other.desktop" },
    { ...app, appRevision: "b".repeat(64) },
  ]) {
    expectRejectedForwardingResult(
      await sanitizeSystemRunParamsForForwarding({ ...base, installedApp }),
      "APPROVAL_APP_MISMATCH",
    );
  }
  expect((await approvalManager.getSnapshot(record.id))?.consumedDecision).toBeUndefined();
  expectAllowOnceForwardingResult(await sanitizeSystemRunParamsForForwarding(base));
  expect((await approvalManager.getSnapshot(record.id))?.consumedDecision).toBe("allow-once");
  expectRejectedForwardingResult(
    await sanitizeSystemRunParamsForForwarding(base),
    "APPROVAL_REQUIRED",
  );
});
