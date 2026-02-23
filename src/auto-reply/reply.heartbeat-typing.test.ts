import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createTempHomeHarness, makeReplyConfig } from "./reply.test-harness.js";

const runEmbeddedPiAgentMock = vi.fn();

vi.mock(
  "../agents/model-fallback.js",
  async () => await import("../test-utils/model-fallback.mock.js"),
);

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (params: unknown) => runEmbeddedPiAgentMock(params),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

const webMocks = vi.hoisted(() => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../web/session.js", () => webMocks);

import { getReplyFromConfig } from "./reply.js";

const { withTempHome } = createTempHomeHarness({
  prefix: "openclaw-typing-",
  beforeEachCase: () => runEmbeddedPiAgentMock.mockClear(),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getReplyFromConfig typing (heartbeat)", () => {
  async function runReplyFlow(isHeartbeat: boolean): Promise<ReturnType<typeof vi.fn>> {
    const onReplyStart = vi.fn();
    await withTempHome(async (home) => {
      runEmbeddedPiAgentMock.mockResolvedValueOnce({
        payloads: [{ text: "ok" }],
        meta: {},
      });

      await getReplyFromConfig(
        { Body: "hi", From: "+1000", To: "+2000", Provider: "whatsapp" },
        { onReplyStart, isHeartbeat },
        makeReplyConfig(home) as unknown as OpenClawConfig,
      );
    });
    return onReplyStart;
  }

  beforeEach(() => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  });

  it("starts typing for normal runs", async () => {
    const onReplyStart = await runReplyFlow(false);
    expect(onReplyStart).toHaveBeenCalled();
  });

  it("does not start typing for heartbeat runs", async () => {
    const onReplyStart = await runReplyFlow(true);
    expect(onReplyStart).not.toHaveBeenCalled();
  });
});
