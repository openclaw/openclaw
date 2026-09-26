// A refused reviewer and an approval bound to another account are different answers.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  resolveExecApprovalRequestAllowedDecisions,
  type ExecApprovalRequestPayload,
} from "../../infra/exec-approvals.js";
import type { OpenClawStateDatabaseOptions } from "../../state/openclaw-state-db.js";
import { ExecApprovalManager } from "../exec-approval-manager.js";
import { createApprovalHandlers } from "./approval.js";
import { createExecApprovalHandlers } from "./exec-approval.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

const prepareApprovalChannelCustodyMock = vi.hoisted(() => vi.fn());
vi.mock("../approval-channel-custody.js", () => ({
  prepareApprovalChannelCustody: prepareApprovalChannelCustodyMock,
}));

function createDatabaseOptions(): OpenClawStateDatabaseOptions {
  const stateDir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-approval-custody-")),
  );
  return { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } };
}

function createContext() {
  return {
    broadcast: vi.fn(),
    broadcastToConnIds: vi.fn(),
    approvalEvents: { publishRequested: vi.fn(() => 0), publishResolved: vi.fn() },
    getApprovalClientConnIds: vi.fn(() => new Set<string>()),
    getRuntimeConfig: () => ({}),
    logGateway: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as unknown as GatewayRequestHandlerOptions["context"];
}

describe("channel custody responses", () => {
  // A refusal answers who may decide; answering not-found instead leaves every channel retiring
  // a control a listed approver could still use. An approval bound to another account stays
  // not-found: saying more would confirm that account's id to this one. The legacy method
  // refuses before its record lookup, so both methods need the same answer pinned.
  it.each([
    ["approval.resolve", "refuses the reviewer", null, "FORBIDDEN", "APPROVAL_AUTHORITY_REQUIRED"],
    [
      "approval.resolve",
      "belongs to another account",
      { resolverId: "telegram:ops", authorizes: () => false },
      "INVALID_REQUEST",
      "APPROVAL_NOT_FOUND",
    ],
    [
      "exec.approval.resolve",
      "refuses the reviewer",
      null,
      "FORBIDDEN",
      "APPROVAL_AUTHORITY_REQUIRED",
    ],
    [
      "exec.approval.resolve",
      "belongs to another account",
      { resolverId: "telegram:ops", authorizes: () => false },
      "INVALID_REQUEST",
      "APPROVAL_NOT_FOUND",
    ],
  ])("%s when the channel %s", async (method, _label, custody, code, reason) => {
    const databaseOptions = createDatabaseOptions();
    const manager = new ExecApprovalManager({
      approvalKind: "exec",
      persistence: { runtimeEpoch: "approval-custody-test", databaseOptions },
      resolveAllowedDecisions: resolveExecApprovalRequestAllowedDecisions,
      resolveAudienceSessionKeys: (source: string) => [source],
    } as never);
    const record = manager.create(
      {
        command: "printf custody",
        host: "gateway",
        agentId: "main",
        sessionKey: "agent:main:child",
        turnSourceChannel: "telegram",
        turnSourceAccountId: "ops",
      } as ExecApprovalRequestPayload,
      600_000,
      "custody-response",
    );
    record.requestedByConnId = null;
    record.requestedByDeviceId = "requester-device";
    record.requestedByClientId = "requester-client";
    record.requestedByDeviceTokenAuth = true;
    record.approvalReviewerDeviceIds = [];
    const { decision } = await manager.register(record, 600_000);
    void decision.catch(() => {});
    prepareApprovalChannelCustodyMock.mockReturnValue(custody);

    const handlers =
      method === "approval.resolve"
        ? createApprovalHandlers({
            execApprovalManager: manager,
            pluginApprovalManager: manager as never,
            systemAgentApprovalManager: manager as never,
            databaseOptions,
          } as never)
        : createExecApprovalHandlers(manager);
    const respond = vi.fn();
    const reviewer = { channel: "telegram", accountId: "ops", senderId: "owner" };
    const body =
      method === "approval.resolve"
        ? { id: record.id, kind: "exec", decision: "allow-once", reviewer }
        : { id: record.id, decision: "allow-once", reviewer };
    await expectDefined(
      handlers[method],
      `${method} handler test invariant`,
    )({
      req: { id: "req-1", type: "req", method, params: body },
      params: body,
      client: {
        connId: "conn-1",
        connect: { client: { id: "t", displayName: "t" }, scopes: ["operator.approvals"] },
        internal: { approvalRuntime: true },
      } as unknown as GatewayRequestHandlerOptions["client"],
      context: createContext(),
      isWebchatConnect: () => false,
      respond,
    } as never);

    const error = respond.mock.calls[0]?.[2];
    expect(error?.code).toBe(code);
    expect(error?.details?.code ?? error?.details?.reason).toBe(reason);
  });
});
