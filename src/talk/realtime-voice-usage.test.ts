import { describe, expect, it } from "vitest";
import { loadTranscriptEvents, replaceSessionEntry } from "../config/sessions/session-accessor.js";
import { useTempSessionsFixture } from "../config/sessions/test-helpers.js";
import { parseUsageCostTranscriptRecord } from "../infra/session-cost-usage-pricing.js";
import type { RealtimeVoiceUsageReport } from "./provider-types.js";
import { recordRealtimeVoiceUsage } from "./realtime-voice-usage.js";

const usage = (responseId: string, status: RealtimeVoiceUsageReport["status"] = "completed") => ({
  provider: "openai",
  model: "gpt-realtime-2.1",
  responseId,
  status,
  input: { text: 700, audio: 750, image: 50 },
  cachedInput: { text: 400, audio: 200, image: 0 },
  output: { text: 100, audio: 300 },
});

describe("recordRealtimeVoiceUsage", () => {
  const fixture = useTempSessionsFixture("realtime-voice-usage-test-");

  it("records each billed response once as a hidden usage row", async () => {
    const scope = {
      sessionId: "voice-session",
      sessionKey: "agent:main:discord:channel:voice",
      storePath: fixture.storePath(),
    };
    await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: Date.now() });
    const record = (report: RealtimeVoiceUsageReport) =>
      recordRealtimeVoiceUsage({
        cfg: { session: { store: scope.storePath } },
        agentId: "main",
        sessionKey: scope.sessionKey,
        usage: report,
      });

    await record(usage("response_1"));
    // A replayed report after reconnect or rotation carries the same response id.
    await record(usage("response_1"));
    await record(usage("response_2", "cancelled"));

    const rows = (await loadTranscriptEvents(scope))
      .map((event) => event as { type?: string; message?: Record<string, unknown> })
      .filter((event) => event.type === "message");
    expect(rows.map((row) => row.message)).toMatchObject([
      { role: "assistant", content: [], display: false, stopReason: "stop" },
      { role: "assistant", content: [], display: false, stopReason: "stop" },
    ]);
    expect(rows.map((row) => parseUsageCostTranscriptRecord(row))).toMatchObject([
      {
        provider: "openai",
        model: "gpt-realtime-2.1",
        usage: { input: 900, output: 400, cacheRead: 600, cacheWrite: 0, total: 1_900 },
      },
      { provider: "openai", model: "gpt-realtime-2.1", usage: { input: 900, output: 400 } },
    ]);
  });
});
