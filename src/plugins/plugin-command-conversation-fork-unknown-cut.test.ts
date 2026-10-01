import { expect, it, vi } from "vitest";
import { SqliteWorkerError } from "../infra/sqlite-worker-contract.js";
import { createPluginCommandConversationForkHost } from "./plugin-command-conversation-fork.js";

const mocks = vi.hoisted(() => ({
  cut: vi.fn(),
  record: vi.fn(),
}));

vi.mock("../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: () => ({
    getCapabilities: () => ({ bindSupported: true, placements: ["current"] }),
    resolveByConversation: () => null,
    resolveByConversationAsync: async () => null,
  }),
  isSessionBindingError: () => false,
}));
vi.mock("./plugin-command-conversation-fork-pending.js", () => ({
  hasPendingChildPlacement: async () => false,
}));
vi.mock("./plugin-command-conversation-fork-reply-selection.js", () => ({
  readPluginForkReplySelection: async () => ({
    status: "found",
    entryId: "user-1",
    text: "original prompt",
  }),
}));
vi.mock("../gateway/session-utils-store-worker.js", () => ({
  resolveGatewaySessionStoreTargetInWorker: async () => ({
    agentId: "main",
    canonicalKey: "agent:main:source",
    storePath: "/tmp/unknown-cut-test.sqlite",
    storeKeys: ["agent:main:source"],
    store: { "agent:main:source": { sessionId: "source-id", lifecycleRevision: "source-rev" } },
  }),
}));
vi.mock("../sessions/session-lifecycle-admission.js", () => ({
  isCompetingSessionWorkAdmissionActive: () => false,
  runExclusiveSessionLifecycleMutation: async ({ run }: { run: () => Promise<void> }) =>
    await run(),
}));
vi.mock("../sessions/session-created.js", () => ({ recordSessionCreated: mocks.record }));
vi.mock("../config/sessions/session-accessor.sqlite-message-cut-worker.js", () => ({
  forkSessionAtMessageInWorker: mocks.cut,
}));

it("consumes a reply ticket after a worker cut with unknown commit outcome", async () => {
  const error = new SqliteWorkerError("lost fork result", "outcome-unknown");
  mocks.cut.mockRejectedValueOnce(error);
  const host = createPluginCommandConversationForkHost({
    config: {},
    agentId: "main",
    sessionKey: "agent:main:source",
    conversation: { channel: "telegram", accountId: "default", conversationId: "-100123" },
    replyToId: "message-1",
    signal: new AbortController().signal,
  });
  const plan = await host.prepare();
  if (plan.status !== "ready") {
    throw new Error("expected ready reply ticket");
  }
  await expect(host.execute({ ticket: plan.ticket, placement: "current" })).rejects.toBe(error);
  await expect(host.execute({ ticket: plan.ticket, placement: "current" })).resolves.toEqual({
    status: "blocked",
    reason: "unauthorized",
  });
  expect(mocks.cut).toHaveBeenCalledOnce();
  expect(mocks.record).not.toHaveBeenCalled();
});
