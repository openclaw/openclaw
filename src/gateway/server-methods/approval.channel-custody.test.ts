// Chat approvals carry a channel reviewer; the Gateway rechecks its custody at the final write.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { createContext } from "./approval.test-support.js";

const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());

vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: prepareApprovalChannelCustodyMock,
}));

function createFixture(includeSystemAgent = false) {
  const databaseOptions = createDatabaseOptions();
  const managers = createManagers(databaseOptions);
  const handlers = createApprovalHandlers({
    execApprovalManager: managers.exec,
    pluginApprovalManager: managers.plugin,
    systemAgentApprovalManager: includeSystemAgent ? managers.systemAgent : undefined,
    databaseOptions,
  });
  return { databaseOptions, managers, handlers };
}

describe("approval.resolve channel reviewer custody", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupApprovalHandlerFixtures();
  });

  it("resolves a system-agent proposal through its channel reviewer custody", async () => {
    const { managers, handlers } = createFixture(true);
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
    const { databaseOptions, managers, handlers } = createFixture(true);
    const pending = await registerSystemAgent(managers.systemAgent, "system-agent:revoked-owner");
    // Custody holds when the request arrives, then the owner is removed before the decision write.
    prepareApprovalChannelCustodyMock
      .mockReturnValueOnce({ resolverId: "irc:default", authorizes: () => true })
      .mockReturnValue(null);
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

  it("refuses a plugin reviewer revoked between lookup and the final decision write", async () => {
    const { databaseOptions, managers, handlers } = createFixture();
    const record = managers.plugin.create(
      {
        title: "Plugin permission",
        description: "Allow one action",
        severity: "warning",
        pluginId: "diffs",
        toolName: "view",
        agentId: "main",
        sessionKey: "agent:main:child",
        turnSourceChannel: "slack",
        turnSourceAccountId: "default",
      },
      600_000,
      "plugin:revoked-slack-reviewer",
    );
    record.requestedByDeviceId = "requester-device";
    record.requestedByClientId = "requester-client";
    record.requestedByDeviceTokenAuth = true;
    record.approvalReviewerDeviceIds = ["reviewer"];
    const pending = (await managers.plugin.register(record, 600_000)).decision;
    const reviewerId = (userId: string) => `team:T11111111:user:${userId}`;
    const configWithReviewer = (userId: string): OpenClawConfig => ({
      approvals: { plugin: { slack: { approvers: [reviewerId(userId)] } } },
    });
    const nextConfig = configWithReviewer("U22222222");
    let config = configWithReviewer("U11111111");
    prepareApprovalChannelCustodyMock.mockImplementation(
      ({ cfg, reviewer }: { cfg: OpenClawConfig; reviewer: { senderId: string } }) => {
        const authorized = cfg.approvals?.plugin?.slack?.approvers?.includes(
          reviewerId(reviewer.senderId),
        );
        if (authorized && reviewer.senderId === "U11111111") {
          config = nextConfig;
        }
        return authorized ? { resolverId: "slack:default", authorizes: () => true } : null;
      },
    );
    const context = { ...createContext(), getRuntimeConfig: () => config };
    const resolve = async (senderId: string) =>
      await invoke({
        handlers,
        method: "approval.resolve",
        body: {
          id: record.id,
          kind: "plugin",
          decision: "allow-once",
          reviewer: { channel: "slack", accountId: "default", senderId },
        },
        client: createClient({ internal: true }),
        context,
      });

    expect((await resolve("U11111111")).result).toBeUndefined();
    expect((await getOperatorApproval({ id: record.id, databaseOptions }))?.status).toBe("pending");
    expect((await resolve("U22222222")).result).toMatchObject({ applied: true });
    await expect(pending).resolves.toBe("allow-once");
  });

  it("checks live channel custody before the canonical resolution CAS", async () => {
    const { databaseOptions, managers, handlers } = createFixture();
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
