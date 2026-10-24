import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedHandoffSentinelRequest } from "../../infra/update-managed-service-handoff-sentinel.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { listCoreAdvertisedGatewayMethodNames } from "../methods/core-method-policy.js";
import { createDirectChatContext } from "../server-chat.agent-events.test-helpers.js";
import { coreGatewayHandlers } from "./core-handlers.js";
import type { RespondFn } from "./types.js";

const owner = vi.hoisted(() => vi.fn());
const method = "update.handoffSentinel";
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
const inspect = (input: object) => ({ ...request, operation: { kind: "inspect", input } });
function record(message?: string): ManagedHandoffSentinelRequest {
  return {
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
          message,
          stats: { ...identity, mode: "unknown", reason: "candidate-failed", steps: [] },
        },
        reason: "candidate-failed",
        triageHint: "Run openclaw update repair",
        serviceKind: "launchd",
        handoffFailure: "candidate-failed",
      },
    },
  };
}

beforeEach(() => {
  owner.mockReset();
});

async function invoke(params: Record<string, unknown>) {
  const respond = vi.fn<RespondFn>();
  await coreGatewayHandlers[method]!({
    req: { type: "req", id: "handoff-sentinel", method },
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
    expect(authorizeOperatorScopesForMethod(method, ["operator.admin"])).toEqual({
      allowed: true,
    });
    expect(authorizeOperatorScopesForMethod(method, ["operator.write"])).toEqual({
      allowed: false,
      missingScope: "operator.admin",
    });
    expect(listCoreAdvertisedGatewayMethodNames()).not.toContain(method);
  });

  it.each([
    ["SQL operation", { ...request, operation: { kind: "sql", input: "SELECT 1" } }],
    ["connection field", { ...request, connection: "postgresql://fixture.invalid/db" }],
    [
      "caller failure policy",
      inspect({ ...identity, nonFailureSkippedReasons: ["candidate-failed"] }),
    ],
    [
      "invalid helper identity",
      {
        ...request,
        helper: { pid: 123, startIdentity: "fixture", startIdentitySource: "argv-sha256" },
      },
    ],
    ["oversized notice", record("x".repeat(65_537))],
  ] as const)("rejects %s before entering the owner", async (_name, params) => {
    expect(await invoke(params)).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(owner).not.toHaveBeenCalled();
  });

  it("preserves a refused owner outcome as a successful transport response", async () => {
    owner.mockResolvedValue({ kind: "refused", sentinel: null });
    expect(await invoke(record())).toHaveBeenCalledWith(true, { kind: "refused", sentinel: null });
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
