import { describe, expect, it, vi } from "vitest";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  refreshPullRequestsForFinalReply,
  refreshPullRequestsForStreamedLinks,
  retirePullRequestRefreshes,
} from "./chat-pull-request-refresh.ts";

type Host = Parameters<typeof refreshPullRequestsForFinalReply>[0];

function createHost() {
  const refresh = vi.fn(() => true);
  const state: Host = {
    client: createTestGatewayClient(() => ({})),
    connectionEpoch: 1,
    sessionKey: "agent:main:demo",
    refreshSessionPullRequests: refresh,
  };
  return { state, refresh };
}

const text = "Opened https://github.com/openclaw/openclaw/pull/111532";
const message = { role: "assistant", content: [{ type: "text", text }] };

describe("PR refresh emission receipts", () => {
  it("records only admitted stream refreshes", () => {
    const { state, refresh } = createHost();
    const emit = () => refreshPullRequestsForStreamedLinks(state, "run-1", text);
    refresh.mockReturnValueOnce(false);
    emit();
    emit();
    emit();
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenLastCalledWith({ refresh: true, automatic: true });
  });

  it("reuses canonical final identity for legacy text normalization", () => {
    const { state, refresh } = createHost();
    refreshPullRequestsForFinalReply(state, "run-1", { text });
    refreshPullRequestsForFinalReply(state, "run-1", message);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("retires receipts on explicit reset", () => {
    const { state, refresh } = createHost();
    refreshPullRequestsForFinalReply(state, "run-1", message);
    retirePullRequestRefreshes(state);
    refreshPullRequestsForFinalReply(state, "run-1", message);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("retains receipts across equivalent main-session spellings", () => {
    const { state, refresh } = createHost();
    state.hello = {
      snapshot: {
        sessionDefaults: {
          defaultAgentId: "main",
          mainKey: "main",
          mainSessionKey: "agent:main:main",
        },
      },
    };
    state.sessionKey = "main";
    refreshPullRequestsForFinalReply(state, "run-1", message);
    state.sessionKey = "agent:main:main";
    refreshPullRequestsForFinalReply(state, "run-1", message);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps unidentified runs eligible for freshness", () => {
    const { state, refresh } = createHost();
    refreshPullRequestsForFinalReply(state, undefined, message);
    refreshPullRequestsForFinalReply(state, undefined, message);
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("evicts old receipts while retaining recently emitted finals", () => {
    const { state, refresh } = createHost();
    for (let index = 0; index < 1_000; index += 1) {
      refreshPullRequestsForFinalReply(state, `run-${index}`, message);
    }
    refreshPullRequestsForFinalReply(state, "run-999", message);
    expect(refresh).toHaveBeenCalledTimes(1_000);
    refreshPullRequestsForFinalReply(state, "run-0", message);
    expect(refresh).toHaveBeenCalledTimes(1_001);
  });
});
