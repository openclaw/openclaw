import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedHandoffSentinelRequest } from "../../infra/update-managed-service-handoff-sentinel.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { listCoreAdvertisedGatewayMethodNames } from "../methods/core-method-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const owner = vi.hoisted(() => vi.fn());
vi.mock("../../infra/update-managed-service-handoff-sentinel.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../infra/update-managed-service-handoff-sentinel.js")
  >()),
  runManagedHandoffSentinelOwnerRequest: owner,
}));

const identity = {
  handoffId: "handoff-fixture",
  runId: "run-fixture",
  root: "/fixture/install",
};
const request: ManagedHandoffSentinelRequest = {
  operation: { kind: "inspect", input: identity },
  databaseIdentity: {
    databasePath: "/fixture/leases/managed-update.sqlite",
    databaseIdentity: "1:2",
    parentIdentity: "1:3",
  },
  helper: { pid: 123, startIdentity: "fixture-start" },
};
const record = {
  ...request,
  operation: {
    kind: "record",
    input: {
      ...identity,
      expectedRevision: 123,
      completedStatus: "error",
      restored: true,
      fallbackPayload: {
        kind: "update",
        status: "error",
        ts: 123,
        stats: {
          handoffId: identity.handoffId,
          runId: identity.runId,
          root: identity.root,
          mode: "unknown",
          reason: "candidate-failed",
          steps: [],
        },
      },
      reason: "candidate-failed",
      triageHint: "Run openclaw update repair",
      serviceKind: "launchd",
      handoffFailure: "candidate-failed",
    },
  },
} satisfies ManagedHandoffSentinelRequest;

beforeEach(() => {
  owner.mockReset();
});

async function invoke(params: Record<string, unknown>) {
  const respond = vi.fn<RespondFn>();
  await coreGatewayHandlers["update.handoffSentinel"]!({
    req: { type: "req", id: "handoff-sentinel", method: "update.handoffSentinel" },
    params,
    context: createDirectChatContext(),
    client: null,
    isWebchatConnect: () => false,
    respond,
  });
  return respond;
}

describe("internal managed handoff sentinel Gateway boundary", () => {
  it("requires administrator scope and stays out of method discovery", () => {
    expect(authorizeOperatorScopesForMethod("update.handoffSentinel", ["operator.admin"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod("update.handoffSentinel", ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(listCoreAdvertisedGatewayMethodNames()).not.toContain("update.handoffSentinel");
  });

  it.each([
    {
      name: "SQL operation",
      params: { ...request, operation: { kind: "sql", input: "SELECT 1" } },
    },
    {
      name: "connection field",
      params: { ...request, connection: "postgresql://fixture.invalid/db" },
    },
    {
      name: "caller failure policy",
      params: {
        ...request,
        operation: {
          kind: "inspect",
          input: {
            ...identity,
            nonFailureSkippedReasons: ["candidate-failed"],
          },
        },
      },
    },
    {
      name: "invalid helper identity",
      params: {
        ...request,
        helper: { pid: 123, startIdentity: "fixture", startIdentitySource: "argv-sha256" },
      },
    },
    {
      name: "oversized notice",
      params: {
        ...record,
        operation: {
          ...record.operation,
          input: {
            ...record.operation.input,
            fallbackPayload: {
              ...record.operation.input.fallbackPayload,
              message: "x".repeat(65_537),
            },
          },
        },
      },
    },
  ])("rejects $name before entering the owner", async ({ params }) => {
    expect(await invoke(params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(owner).not.toHaveBeenCalled();
  });

  it("preserves a refused owner outcome as a successful transport response", async () => {
    owner.mockResolvedValue({ kind: "refused", sentinel: null });
    expect(await invoke(record)).toHaveBeenCalledWith(true, { kind: "refused", sentinel: null });
    expect(owner).toHaveBeenCalledOnce();
  });

  it("does not expose owner diagnostics through the transport error", async () => {
    owner.mockImplementation(async () => {
      throw new Error("PostgreSQL failed for postgresql://fixture.invalid/private");
    });
    const respond = await invoke(request);
    expect(owner).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "UNAVAILABLE",
      message: "Handoff sentinel operation failed",
    });
    expect(JSON.stringify(respond.mock.calls)).not.toContain("postgresql:");
  });
});
