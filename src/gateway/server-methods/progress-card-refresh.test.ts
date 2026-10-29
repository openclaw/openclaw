import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ProgressCard } from "../../../packages/gateway-protocol/src/index.js";
import { makeAgentAssistantMessage } from "../../agents/test-helpers/agent-message-fixtures.js";
import { progressCardStore } from "../progress-card-store.js";
import type { handleTrustedInternalChatSend } from "./chat-send-handler.js";
import { progressCardHandlers } from "./progress-card.js";
import type { GatewayRequestHandlerOptions, RespondFn } from "./types.js";

const { send } = vi.hoisted(() => ({ send: vi.fn<typeof handleTrustedInternalChatSend>() }));
vi.mock("./chat-send-handler.js", () => ({ handleTrustedInternalChatSend: send }));
afterEach(() => vi.restoreAllMocks());
const card: ProgressCard = {
  sessionKey: "agent:work:status",
  revision: 7,
  updatedAt: 1,
  markdown: "Old status",
};
function fixture() {
  vi.spyOn(progressCardStore, "get").mockResolvedValue(card);
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
    },
    sessionMutationAuthorization: { assertCurrent },
    sessionMutationCommitGuard: assertCurrent,
  } as unknown as GatewayRequestHandlerOptions;
  send.mockReset().mockImplementation(async (req) => req.respond(true, { status: "started" }));
  return {
    respond,
    invocation,
    invoke: () => progressCardHandlers["progressCard.refresh"]!(invocation),
  };
}
it("refresh dispatches a hidden steer with caller authority and session-bound retry identity", async () => {
  const f = fixture();
  await f.invoke();
  const [request, , options] = expectDefined(send.mock.calls[0], "refresh dispatch");
  expect(request.client).toBe(f.invocation.client);
  expect(request.sessionMutationAuthorization).toBe(f.invocation.sessionMutationAuthorization);
  expect(request.params.message).toContain("not authorization to resume stopped or idle work");
  const assistant = makeAgentAssistantMessage({ content: [{ type: "text", text: "Updated" }] });
  expect(options?.prepareAssistantTranscriptMessage?.(assistant, "Updated")).toEqual({
    ...assistant,
    display: false,
  });
  await f.invoke();
  const original = send.mock.calls[0]?.[0].params.idempotencyKey;
  expect(original).toEqual(expect.any(String));
  expect(send.mock.calls[1]?.[0].params.idempotencyKey).toBe(original);
  f.invocation.params = { sessionKey: "agent:work:other", idempotencyKey: "click-1" };
  await f.invoke();
  expect(send.mock.calls[2]?.[0].params.idempotencyKey).not.toBe(original);
});
it.each(["invalid fields", "error", "aborted"])("rejects refresh: %s", async (status) => {
  const f = fixture();
  const invalid = status === "invalid fields";
  if (invalid) {
    f.invocation.params = { ...f.invocation.params, message: "resume all work", hidden: true };
  } else {
    send.mockImplementation(async (request) => request.respond(true, { status }));
  }
  await f.invoke();
  expect(f.respond.mock.calls[0]).toMatchObject({
    0: false,
    1: undefined,
    2: { code: invalid ? "INVALID_REQUEST" : "UNAVAILABLE" },
  });
  if (invalid) {
    expect(send).not.toHaveBeenCalled();
  }
});
