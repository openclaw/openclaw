// Chat approvals carry a channel reviewer; the Gateway rechecks its custody at the final write.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExecApprovalRequestPayload } from "../../infra/exec-approvals.js";
import type { SystemAgentApprovalRequestPayload } from "../../infra/system-agent-approvals.js";
import {
  cleanupApprovalHandlerFixtures,
  createClient,
  createDatabaseOptions,
  createManagers,
  getOperatorApproval,
  invoke,
  registerExec,
  registerSystemAgent,
} from "./approval.handlers.test-support.js";
import { createApprovalHandlers } from "./approval.js";

const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());

vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: prepareApprovalChannelCustodyMock,
}));

describe("approval.resolve channel reviewer custody", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupApprovalHandlerFixtures();
  });

  it("resolves a system-agent proposal through its channel reviewer custody", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerSystemAgent(
      managers.systemAgent,
      "system-agent:channel-reviewer",
    );
    prepareApprovalChannelCustodyMock.mockImplementation(
      ({ approvalKind }: { approvalKind: string }) =>
        approvalKind === "system-agent"
          ? {
              resolverId: "telegram:ops",
              authorizes: (record: { request: SystemAgentApprovalRequestPayload }) =>
                record.request.sessionId === "delegation-1",
            }
          : null,
    );
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      systemAgentApprovalManager: managers.systemAgent,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: {
        id: pending.record.id,
        kind: "system-agent",
        decision: "allow-once",
        reviewer: { channel: "telegram", accountId: "ops", senderId: "owner" },
      },
      client: createClient({ internal: true }),
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: { status: "allowed", decision: "allow-once" },
    });
    await expect(pending.decision).resolves.toBe("allow-once");
  });

  it("refuses a system-agent decision when reviewer custody is revoked before the final write", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerSystemAgent(managers.systemAgent, "system-agent:revoked-owner");
    // Custody holds when the request arrives, then the owner is removed before the decision write.
    prepareApprovalChannelCustodyMock
      .mockReturnValueOnce({ resolverId: "irc:default", authorizes: () => true })
      .mockReturnValue(null);
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      systemAgentApprovalManager: managers.systemAgent,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: {
        id: pending.record.id,
        kind: "system-agent",
        decision: "allow-once",
        reviewer: { channel: "irc", accountId: "default", senderId: "alice" },
      },
      client: createClient({ internal: true }),
    });

    expect(response.result).toBeUndefined();
    expect((await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.status).toBe(
      "pending",
    );
  });

  it("checks live channel custody before the canonical resolution CAS", async () => {
    const databaseOptions = createDatabaseOptions();
    const managers = createManagers(databaseOptions);
    const pending = await registerExec(managers.exec, {
      id: "channel-custody-cas",
      request: { turnSourceChannel: "telegram", turnSourceAccountId: "ops" },
      reviewerDeviceIds: [],
    });
    prepareApprovalChannelCustodyMock.mockReturnValue({
      resolverId: "telegram:ops",
      authorizes: (request: { request: ExecApprovalRequestPayload }) =>
        request.request.turnSourceAccountId === "ops",
    });
    const handlers = createApprovalHandlers({
      execApprovalManager: managers.exec,
      pluginApprovalManager: managers.plugin,
      databaseOptions,
    });

    const response = await invoke({
      handlers,
      method: "approval.resolve",
      body: {
        id: pending.record.id,
        kind: "exec",
        decision: "deny",
        reviewer: { channel: "telegram", accountId: "ops", senderId: "owner" },
      },
      client: createClient({ internal: true }),
    });

    expect(response.result).toMatchObject({
      applied: true,
      approval: { status: "denied", decision: "deny" },
    });
    expect(
      (await getOperatorApproval({ id: pending.record.id, databaseOptions }))?.resolver,
    ).toEqual({
      kind: "channel",
      id: "telegram:ops",
    });
  });
});
