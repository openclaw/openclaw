import { beforeEach, expect, it, vi } from "vitest";
import { recordAgentRunTerminalOutcome } from "../channels/turn/agent-run-terminal-outcome.js";
import type { RuntimeEnv } from "../runtime.js";
import type { TemplateInstallEvent } from "../shared/template-install-notice.js";
import { createLocalTemplateConversationAdapters } from "./templates-agent-conversation.js";

const mocks = vi.hoisted(() => ({
  turn: vi.fn(),
  ready: vi.fn(),
  prepare: vi.fn(),
  publish: vi.fn(),
  rollback: vi.fn(),
  context: { localEmbedded: true },
}));
// mock-isolation: hold normal model/runtime owners at their public boundary; this file proves adapter policy, not inference or runtime activation.
vi.mock("../agents/agent-command.js", () => ({ agentCommandFromSystem: mocks.turn }));
// mock-isolation: readiness is an explicit adapter boundary; do not load real model workers.
vi.mock("../agents/agent-command-local.js", () => ({ runLocalAgentCommand: mocks.ready }));
// mock-isolation: canonical session and receipt storage have integration coverage at the Gateway owners.
vi.mock("../gateway/server-methods/agents-onboarding.js", () => ({
  completeAgentOnboarding: mocks.prepare,
}));
// mock-isolation: exercise adapter event wiring without a live Gateway or receipt database.
vi.mock("../gateway/server-methods/templates-add-conversation.js", () => ({
  publishTemplateInstallEvent: mocks.publish,
}));
// mock-isolation: the adapter is tested in an admitted local scope, not a running Gateway.
vi.mock("../gateway/local-request-context.js", () => ({
  withLocalGatewayRequestScope: async (_params: unknown, run: () => Promise<unknown>) => run(),
}));
// mock-isolation: pin the local request context without activating plugin runtime globals.
vi.mock("../plugins/runtime/gateway-request-scope.js", () => ({
  getPluginRuntimeGatewayRequestScope: () => ({ context: mocks.context }),
}));

const visible = () =>
  recordAgentRunTerminalOutcome(
    {
      meta: { terminalReply: { disposition: "visible", text: "Hello from Scout" } },
      payloads: [{ text: "Hello from Scout" }],
    },
    "completed",
  );
const event: TemplateInstallEvent = {
  agentId: "scout",
  sessionKey: "agent:scout:home",
  kind: "automation-created",
  declarationId: "morning",
  schedulerJobId: "scheduler-morning",
  name: "Morning review",
  enabled: false,
};
function fixture() {
  const signal = new AbortController().signal;
  const assertCurrent = vi.fn();
  const runtime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
  return {
    signal,
    assertCurrent,
    runtime,
    adapters: createLocalTemplateConversationAdapters({
      agentId: "scout",
      signal,
      assertCurrent,
      runtime,
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.prepare.mockReset().mockResolvedValue({
    status: "completed",
    sessionKey: event.sessionKey,
    rollback: mocks.rollback,
  });
  mocks.ready.mockReset().mockImplementation(async (params) => params.run());
  mocks.turn.mockReset().mockResolvedValue(visible());
  mocks.publish.mockReset().mockResolvedValue(undefined);
  mocks.context.localEmbedded = true;
});
it.for(["silent", "error"])(
  "rejects %s model completion so shared Add retains partial state",
  async (failure) => {
    const { adapters } = fixture();
    const response = visible();
    if (failure === "silent") {
      response.meta.terminalReply.disposition = "silent";
    } else {
      recordAgentRunTerminalOutcome(response, "failed");
    }
    mocks.turn.mockResolvedValue(response);
    await expect(
      adapters.onAgentReady!({ agentId: "scout", sessionKey: event.sessionKey }),
    ).rejects.toThrow("did not complete with visible model output");
  },
);
it("rechecks owner authority after model completion before printing a success", async () => {
  const { adapters, assertCurrent, runtime } = fixture();
  mocks.turn.mockImplementation(async () => {
    assertCurrent.mockImplementation(() => {
      throw new Error("offline custody lost");
    });
    return visible();
  });
  await expect(
    adapters.onAgentReady!({ agentId: "scout", sessionKey: event.sessionKey }),
  ).rejects.toThrow("offline custody lost");
  expect(runtime.log).not.toHaveBeenCalled();
  expect(mocks.publish).not.toHaveBeenCalled();
});
