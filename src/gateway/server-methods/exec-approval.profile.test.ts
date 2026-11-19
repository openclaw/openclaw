import { expect, it, vi } from "vitest";
import { createTestApprovalManager } from "../exec-approval-manager.test-support.js";
import { createApprovalSessionFixture } from "./approval.test-support.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import {
  createExecApprovalClient,
  listExecApprovals,
  resolveExecApprovalForTest,
} from "./exec-approval.test-support.js";

it("lists and resolves only exec approvals raised by the caller's profile", async (testContext) => {
  const { sessionKey } = await createApprovalSessionFixture(testContext);
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
      profileId: name,
      scopes: ["operator.approvals"],
    });
  const ownerClient = client("owner");
  const otherClient = client("other");

  const register = async (name: string, profileId: string) => {
    const record = manager.create(
      { command: `echo ${name}`, agentId: "main", sessionKey },
      60_000,
      `approval-abcd-${name}`,
    );
    record.requestedByProfileId = profileId;
    record.requestedByDeviceId = `device-${profileId}`;
    record.requestedByConnId = `conn-${profileId}`;
    record.requestedByClientId = `client-${profileId}`;
    await manager.register(record, 60_000);
    return record;
  };
  const visible = await register("visible", "owner");
  const hidden = await register("hidden", "other");

  const listRespond = vi.fn();
  await listExecApprovals({ handlers, respond: listRespond, client: ownerClient });
  expect(listRespond.mock.calls[0]?.[0]).toBe(true);
  const approvals = listRespond.mock.calls[0]?.[1] as Array<Record<string, unknown>>;
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
  expect(hiddenRespond.mock.calls[0]?.[0]).toBe(false);
  expect(hiddenRespond.mock.calls[0]?.[2]).toMatchObject({
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
