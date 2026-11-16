import { beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createEventWebPushDelivery } from "./event-web-push.js";

const send = vi.hoisted(() => vi.fn<(input: { payload: { url: string } }) => Promise<[]>>());
vi.mock("../infra/push-web.js", () => ({
  hasBoundWebPushSubscriptions: async () => true,
  prepareWebPushNotificationSender: async () => send,
}));
vi.mock("./web-push-authority.js", () => ({
  withCurrentWebPushAuthority: async (
    { getRuntimeConfig }: { getRuntimeConfig: () => OpenClawConfig },
    publish: (authority: { cfg: OpenClawConfig }) => { start: () => Promise<unknown> },
  ) => publish({ cfg: getRuntimeConfig() }).start(),
  listCurrentWebPushTargets: () => [
    {
      subscription: { deviceId: "browser-device" },
      preferences: {
        enabled: true,
        detailLevel: "private",
        agentIds: [],
        quietHours: { enabled: false },
        categories: { agentFinished: true, agentQuestion: true, scheduledTaskFailed: true },
      },
    },
  ],
  webPushTargetClient: () => ({}),
  webPushSessionAccess: () => ({}),
}));
vi.mock("./web-push-avatar.js", () => ({
  prepareWebPushAgentIcon: async () => undefined,
  currentWebPushAgentIcon: () => undefined,
}));
vi.mock("./session-sharing.js", () => ({ canReceiveSessionEvent: () => true }));
vi.mock("./operator-role-enforcement.js", () => ({
  isNamedOperatorRoleEnforcementEnabled: () => false,
}));

beforeEach(() => send.mockReset().mockResolvedValue([]));

it.each([
  ["question.requested", { id: "question:1" }, "thread.1", "ask/question%3A1"],
  ["chat", { state: "final" }, "thread.1", "chat/research/thread%2E1"],
  [
    "chat",
    { state: "final", runId: "turn-id", sessionKey: "agent:research:other" },
    "cron:nightly:run:old-session",
    "automations?job=nightly&run=old-session",
  ],
  [
    "chat",
    { state: "final" },
    "cron:nightly:run:old-session:subagent:child",
    "chat/research/cron/nightly/run/old-session/subagent/child",
  ],
  [
    "cron",
    { action: "finished", jobId: "nightly", status: "error", runAtMs: 1234 },
    "thread.1",
    "automations?job=nightly&run=cron%3Anightly%3A1234",
  ],
] as const)("routes %s for %s to its originating Gateway", async (event, payload, scope, path) => {
  createEventWebPushDelivery(() => ({
    gateway: { publicOrigin: "https://gateway.example.test", controlUi: { basePath: "/operator" } },
  })).handleEvent(event, payload, {
    agentId: "research",
    sessionKeys: [`agent:research:${scope}`],
  });
  await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
  expect(send.mock.lastCall?.[0].payload.url).toBe(
    `${path}#gatewayUrl=wss%3A%2F%2Fgateway.example.test%2Foperator`,
  );
});
