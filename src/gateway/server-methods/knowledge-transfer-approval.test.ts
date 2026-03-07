import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeTransferApprovalManager } from "../knowledge-transfer-approval-manager.js";
import { createKnowledgeTransferApprovalHandlers } from "./knowledge-transfer-approval.js";

type KnowledgeTransferApprovalHandlers = ReturnType<typeof createKnowledgeTransferApprovalHandlers>;
type RequestArgs = Parameters<
  KnowledgeTransferApprovalHandlers["knowledge.transfer.approval.request"]
>[0];

const baseRequestParams = {
  approvalKind: "export",
  requesterAgentId: "requester",
  targetAgentId: "target",
  requesterSessionKey: "agent:requester:main",
  targetSessionKey: "agent:target:main",
  mode: "ask",
  itemCount: 1,
  itemFingerprints: ["abc123"],
  summary: ["1. test item"],
  timeoutMs: 10_000,
} as const;

function buildRequestContext(params: {
  broadcasts: Array<{ event: string; payload: unknown }>;
  hasExecApprovalClients?: (opts?: { excludeConnId?: string | null }) => boolean;
}): RequestArgs["context"] {
  return {
    broadcast: (event: string, payload: unknown) => {
      params.broadcasts.push({ event, payload });
    },
    hasExecApprovalClients: params.hasExecApprovalClients ?? (() => true),
  } as unknown as RequestArgs["context"];
}

function requestApproval(params: {
  handlers: KnowledgeTransferApprovalHandlers;
  respond: ReturnType<typeof vi.fn>;
  context: RequestArgs["context"];
  requestParams?: Record<string, unknown>;
}) {
  return params.handlers["knowledge.transfer.approval.request"]({
    params: {
      ...baseRequestParams,
      ...params.requestParams,
    } as RequestArgs["params"],
    respond: params.respond as unknown as RequestArgs["respond"],
    context: params.context,
    client: {
      connId: "conn-1",
      connect: {
        client: { id: "client-1" },
        device: { id: "device-1" },
      },
    } as unknown as RequestArgs["client"],
    req: { id: "req-1", type: "req", method: "knowledge.transfer.approval.request" },
    isWebchatConnect: () => false,
  });
}

describe("knowledge transfer approval handlers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
  });

  it("returns immediately in two-phase mode without sending a second response", async () => {
    const manager = new KnowledgeTransferApprovalManager();
    const handlers = createKnowledgeTransferApprovalHandlers(manager);
    const respond = vi.fn();
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const requestPromise = requestApproval({
      handlers,
      respond,
      context: buildRequestContext({ broadcasts }),
      requestParams: { twoPhase: true },
    });

    await expect(requestPromise).resolves.toBeUndefined();
    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ status: "accepted" }),
      undefined,
    );

    const approvalId =
      (respond.mock.calls[0]?.[1] as { id?: string } | undefined)?.id?.toString() ?? "";
    expect(approvalId).not.toBe("");
    expect(manager.resolve(approvalId, "allow", "operator")).toBe(true);

    await Promise.resolve();
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("returns the final decision in single-phase mode", async () => {
    const manager = new KnowledgeTransferApprovalManager();
    const handlers = createKnowledgeTransferApprovalHandlers(manager);
    const respond = vi.fn();
    const broadcasts: Array<{ event: string; payload: unknown }> = [];
    const requestPromise = requestApproval({
      handlers,
      respond,
      context: buildRequestContext({ broadcasts }),
    });

    const pendingEvent = broadcasts.find(
      (entry) => entry.event === "knowledge.transfer.approval.pending",
    );
    const approvalId = (pendingEvent?.payload as { id?: string } | undefined)?.id ?? "";
    expect(approvalId).not.toBe("");

    expect(manager.resolve(approvalId, "allow", "operator")).toBe(true);
    await requestPromise;

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ id: approvalId, decision: "allow" }),
      undefined,
    );
  });

  it("auto-expires when requester is the only approvals client connected", async () => {
    const manager = new KnowledgeTransferApprovalManager();
    const handlers = createKnowledgeTransferApprovalHandlers(manager);
    const respond = vi.fn();
    const broadcasts: Array<{ event: string; payload: unknown }> = [];

    await requestApproval({
      handlers,
      respond,
      context: buildRequestContext({
        broadcasts,
        hasExecApprovalClients: (opts) => opts?.excludeConnId !== "conn-1",
      }),
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ decision: null }),
      undefined,
    );
  });
});
