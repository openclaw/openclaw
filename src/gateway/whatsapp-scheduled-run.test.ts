import { expect, it, vi } from "vitest";
import { cronTestJob } from "../cron/service.fixture-builders.test-support.js";
import { runWhatsAppAutomation } from "./whatsapp-scheduled-run.js";

const mocks = vi.hoisted(() => ({
  admitted: vi.fn<() => Promise<boolean>>(),
  sendText: vi.fn(async (params: { onPlatformSendDispatch(): Promise<void> }) => {
    await params.onPlatformSendDispatch();
    return { messageId: "synthetic-delivery" };
  }),
}));
vi.mock("../cron/whatsapp-automation.js", () => ({
  hasWhatsAppAutomationPermission: mocks.admitted,
}));
vi.mock("../config/io.js", () => ({ getRuntimeConfig: () => ({}) }));
vi.mock("../channels/plugins/registry.js", () => ({
  getChannelPlugin: () => ({ outbound: { sendText: mocks.sendText } }),
}));

it("admits one delivery through its fence and checks withdrawal on the next occurrence", async () => {
  const job = cronTestJob({
    id: "personal",
    agentId: "qa",
    state: { runningAtMs: 1 },
    payload: { kind: "whatsappAutomation", accountId: "default", peer: "+15550000001" },
  });
  const signal = new AbortController().signal;
  const fence = { beforeAttempt: vi.fn(async () => {}), assertCurrent: vi.fn() };
  mocks.admitted.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await runWhatsAppAutomation(job, signal, fence, vi.fn())).toMatchObject({
    status: "ok",
    delivered: true,
  });
  expect(await runWhatsAppAutomation(job, signal, fence, vi.fn())).toMatchObject({
    status: "skipped",
    delivered: false,
  });
  expect(mocks.admitted).toHaveBeenCalledTimes(2);
  expect(mocks.sendText).toHaveBeenCalledOnce();
  expect(fence.beforeAttempt).toHaveBeenCalledOnce();
});
