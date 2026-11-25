import { beforeEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  expectObjectFields as expectRecordFields,
  mockCall,
} from "../../test-utils/mock-call-assertions.js";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import {
  createExecApprovalClient,
  listExecApprovals,
  resolveExecApprovalForTest,
} from "./exec-approval.test-support.js";

beforeEach(() => setRuntimeConfigSnapshot({}));

it("lists and resolves only exec approvals owned by the caller", async (testContext) => {
  const manager = createTestApprovalManager(testContext);
  const handlers = createExecApprovalHandlers(manager);
  const context = {
    broadcast: (_eventValue: string, _payload: unknown) => {},
  };
  const client = (name: string) =>
    createExecApprovalClient({
      connId: `conn-${name}`,
      clientId: `client-${name}`,
      deviceId: `device-${name}`,
    });
  const ownerClient = client("owner");
  const otherClient = client("other");

  const visible = manager.create({ command: "echo visible" }, 60_000, "approval-abcd-visible");
  visible.requestedByDeviceId = "device-owner";
  visible.requestedByConnId = "conn-owner";
  visible.requestedByClientId = "client-owner";
  await manager.register(visible, 60_000);

  const hidden = manager.create({ command: "echo hidden" }, 60_000, "approval-abcd-hidden");
  hidden.requestedByDeviceId = "device-other";
  hidden.requestedByConnId = "conn-other";
  hidden.requestedByClientId = "client-other";
  await manager.register(hidden, 60_000);

  const listRespond = vi.fn();
  await listExecApprovals({ handlers, respond: listRespond, client: ownerClient });
  expect(mockCall(listRespond)[0]).toBe(true);
  const approvals = mockCall(listRespond)[1] as Array<Record<string, unknown>>;
  expect(approvals.map((entry) => entry.id)).toEqual(["approval-abcd-visible"]);

  const resolveRespond = await resolveExecApprovalForTest({
    handlers,
    id: "approval-abcd",
    context,
    client: ownerClient,
  });
  expect(resolveRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
  expect((await manager.getSnapshot(visible.id))?.decision).toBe("allow-once");
  expect((await manager.getSnapshot(hidden.id))?.decision).toBeUndefined();

  const hiddenRespond = await resolveExecApprovalForTest({
    handlers,
    id: hidden.id,
    context,
    client: ownerClient,
  });
  expect(mockCall(hiddenRespond)[0]).toBe(false);
  expectRecordFields(mockCall(hiddenRespond)[2], {
    code: "INVALID_REQUEST",
    message: "unknown or expired approval id",
  });
  expect((await manager.getSnapshot(hidden.id))?.decision).toBeUndefined();

  const otherRespond = await resolveExecApprovalForTest({
    handlers,
    id: hidden.id,
    context,
    client: otherClient,
  });
  expect(otherRespond).toHaveBeenCalledWith(true, { ok: true }, undefined);
});
