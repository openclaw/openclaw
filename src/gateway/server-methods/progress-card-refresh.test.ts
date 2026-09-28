import { describe, expect, it, vi } from "vitest";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { createDeferredCore } from "../../shared/deferred.js";
import type { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { createProgressCardHandlers } from "./progress-card.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const { send } = vi.hoisted(() => ({ send: vi.fn<typeof handleTrustedInternalChatSend>() }));
vi.mock("./chat-send-handler.js", () => ({ handleTrustedInternalChatSend: send }));
const card: ProgressCard = {
  sessionKey: "agent:work:status",
  revision: 7,
  updatedAt: 1,
  markdown: "Old status",
};
function fixture() {
  const get = vi.fn(async () => card as ProgressCard | null);
  const put = vi.fn();
  const handlers = createProgressCardHandlers({ get, put });
  const respond = vi.fn<RespondFn>();
  const assertCurrent = vi.fn();
  const invocation = {
    req: { type: "req", id: "refresh", method: "progressCard.refresh" },
    params: { sessionKey: card.sessionKey, idempotencyKey: "click-1" },
    respond,
    client: { connId: "requester", connect: { scopes: ["operator.write"] } },
    context: {
      dedupe: new Map(),
      getRuntimeConfig: () => ({ agents: { entries: { work: {} }, ownership: "explicit" } }),
      broadcast: vi.fn(),
    },
    sessionMutationAuthorization: { assertCurrent },
    sessionMutationCommitGuard: assertCurrent,
  } as unknown as GatewayRequestHandlerOptions;
  send
    .mockReset()
    .mockImplementation(async (request: GatewayRequestHandlerOptions) =>
      request.respond(true, { status: "started" }),
    );
  return {
    get,
    put,
    respond,
    assertCurrent,
    invocation,
    invoke: () => handlers["progressCard.refresh"]!(invocation),
  };
}
describe("progressCard.refresh", () => {
  it("dispatches a fixed hidden steer under the original caller and keeps the old card", async () => {
    const f = fixture();
    await f.invoke();
    expect(send).toHaveBeenCalledOnce();
    const call = send.mock.calls[0];
    if (!call) {
      throw new Error("Expected refresh dispatch");
    }
    const [request, , options] = call;
    if (!options) {
      throw new Error("Expected hidden refresh dispatch options");
    }
    expect(request.client).toBe(f.invocation.client);
    expect(request.sessionMutationAuthorization).toBe(f.invocation.sessionMutationAuthorization);
    expect(request.params).toMatchObject({
      sessionKey: card.sessionKey,
      agentId: "work",
      queueMode: "steer",
      deliver: false,
      suppressCommandInterpretation: true,
      systemInputProvenance: { kind: "internal_system", sourceTool: "progress_card_refresh" },
    });
    expect(request.params.message).toContain("not authorization to resume stopped or idle work");
    expect(options.transcript).toEqual({ display: false });
    expect(options.toolsAllow).toContain("progress_card");
    expect(options.toolsAllow).not.toContain("exec");
    const assistant = makeAgentAssistantMessage({ content: [{ type: "text", text: "Updated" }] });
    expect(options.prepareAssistantTranscriptMessage?.(assistant, "Updated")).toEqual({
      ...assistant,
      display: false,
    });
    expect(f.respond).toHaveBeenCalledWith(
      true,
      { runId: request.params.idempotencyKey, status: "accepted", revision: 7 },
      undefined,
      undefined,
    );
    expect(f.put).not.toHaveBeenCalled();
    expect(f.invocation.context.broadcast).not.toHaveBeenCalled();
  });
  it("keeps retry identity stable and isolates another agent/session", async () => {
    const f = fixture();
    await f.invoke();
    await f.invoke();
    const original = send.mock.calls[0]?.[0].params.idempotencyKey;
    expect(original).toEqual(expect.any(String));
    expect(send.mock.calls[1]?.[0].params.idempotencyKey).toBe(original);
    f.invocation.params = { sessionKey: "agent:work:other", idempotencyKey: "click-1" };
    await f.invoke();
    expect(send.mock.calls[2]?.[0].params.idempotencyKey).not.toBe(original);
  });
  it("retains the original baseline when a lost acceptance is retried after the card update", async () => {
    const f = fixture();
    await f.invoke();
    f.get.mockResolvedValue({ ...card, revision: 8, updatedAt: 2 });
    await f.invoke();
    expect(f.respond.mock.calls[1]?.[1]).toMatchObject({ status: "accepted", revision: 7 });
  });
  it.each([false, true])(
    "reconciles a completed refresh before permitting a new intent (updated=%s)",
    async (updated) => {
      const f = fixture();
      await f.invoke();
      if (updated) {
        f.get.mockResolvedValue({ ...card, revision: 8, updatedAt: 2 });
      }
      send.mockImplementation(async (request) => request.respond(true, { status: "completed" }));
      await f.invoke();
      if (updated) {
        expect(f.respond).toHaveBeenLastCalledWith(
          true,
          expect.objectContaining({ status: "accepted", revision: 7 }),
          undefined,
          undefined,
        );
      } else {
        expect(f.respond).toHaveBeenLastCalledWith(
          false,
          undefined,
          expect.objectContaining({ details: { code: "PROGRESS_CARD_REFRESH_TERMINAL" } }),
          undefined,
        );
      }
    },
  );
  it("does not treat a cached steering acknowledgment as completed work", async () => {
    const f = fixture();
    await f.invoke();
    send.mockImplementation(async (request) => request.respond(true, { status: "ok" }));
    await f.invoke();
    expect(f.respond).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({ status: "accepted", revision: 7 }),
      undefined,
      undefined,
    );
  });
  it("refuses missing cards and arbitrary prompt/visibility fields", async () => {
    const f = fixture();
    f.get.mockResolvedValue(null);
    await f.invoke();
    expect(send).not.toHaveBeenCalled();
    expect(f.respond).toHaveBeenLastCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    f.invocation.params = { ...f.invocation.params, message: "resume all work", hidden: true };
    await f.invoke();
    expect(send).not.toHaveBeenCalled();
  });
  it("rejects reset or revoked authorization while reading the card", async () => {
    const f = fixture();
    const release = createDeferredCore();
    f.get.mockImplementation(async () => {
      await release.promise;
      return card;
    });
    const pending = f.invoke();
    f.assertCurrent.mockImplementation(() => {
      throw new Error("session was reset");
    });
    release.resolve();
    await expect(pending).rejects.toThrow("session was reset");
    expect(send).not.toHaveBeenCalled();
  });
  it.each(["error", "timeout", "aborted"])(
    "does not report %s as a successful refresh request",
    async (status) => {
      const f = fixture();
      send.mockImplementation(async (request: GatewayRequestHandlerOptions) =>
        request.respond(true, { status }),
      );
      await f.invoke();
      expect(f.respond).toHaveBeenCalledWith(
        false,
        undefined,
        expect.objectContaining({ code: "UNAVAILABLE" }),
        undefined,
      );
      expect(f.put).not.toHaveBeenCalled();
    },
  );
});
