// @vitest-environment jsdom
import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import { expect, it, onTestFinished, vi } from "vitest";
import type { SessionSystemPromptReport } from "../../../src/config/sessions/session-system-prompt-report.js";
import { createApplicationGateway } from "../test-helpers/application-context-fixtures.ts";
import {
  createGatewayRequestMock,
  createTestGatewayClient,
} from "../test-helpers/gateway-client.ts";
import { sessionContextReportsForGateway } from "./session-context-report.ts";

const target = {
  sessionKey: "agent:main:context",
  agentId: "main",
  sessionId: "incarnation",
  model: "example-model",
  provider: "example",
  used: 50000,
};
const report: SessionSystemPromptReport = {
  source: "run",
  generatedAt: 1,
  sessionId: target.sessionId,
  model: target.model,
  provider: target.provider,
  systemPrompt: { chars: 40000, projectContextChars: 16000, nonProjectContextChars: 24000 },
  injectedWorkspaceFiles: [],
  skills: { promptChars: 8000, entries: [] },
  tools: { listChars: 0, schemaChars: 12000, entries: [] },
};
const response = () => ({
  sessions: [{ key: target.sessionKey, sessionId: target.sessionId, contextWeight: report }],
});

it("keeps the production context-report retry backoff across a wall-clock jump while hidden", async () => {
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const request = createGatewayRequestMock();
  request
    .mockRejectedValueOnce(
      new GatewayProtocolRequestError({ code: "UNAVAILABLE", retryable: true }),
    )
    .mockResolvedValue(response());
  const { gateway, publish } = createApplicationGateway();
  const client = createTestGatewayClient(request);
  publish({ ...gateway.snapshot, phase: "connected", client });
  const store = sessionContextReportsForGateway(gateway);
  const owner = {};
  onTestFinished(() => {
    store.unwatch(owner);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  store.watch(owner, target);
  await store.refresh(target);
  expect(request).toHaveBeenCalledTimes(1);

  const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
  document.dispatchEvent(new Event("visibilitychange"));
  vi.setSystemTime(Date.now() + 3_600_000);
  visibility.mockReturnValue("visible");
  document.dispatchEvent(new Event("visibilitychange"));

  // Remaining backoff is ~30s minus a few real ms between schedule and resume.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(request).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(request).toHaveBeenCalledTimes(2);
});
