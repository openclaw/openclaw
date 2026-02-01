import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthSummary } from "./health.js";
import { formatHealthChannelLines, healthCommand } from "./health.js";

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

const callGatewayMock = vi.fn();
vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

describe("healthCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("outputs JSON from gateway", async () => {
    const agentSessions = {
      path: "/tmp/sessions.json",
      count: 1,
      recent: [{ key: "+1555", updatedAt: Date.now(), age: 0 }],
    };
    const snapshot: HealthSummary = {
      ok: true,
      ts: Date.now(),
      durationMs: 5,
      channels: {
        whatsapp: { accountId: "default", linked: true, authAgeMs: 5000 },
        telegram: {
          accountId: "default",
          configured: true,
          probe: { ok: true, elapsedMs: 1 },
        },
        discord: { accountId: "default", configured: false },
      },
      channelOrder: ["whatsapp", "telegram", "discord"],
      channelLabels: {
        whatsapp: "WhatsApp",
        telegram: "Telegram",
        discord: "Discord",
      },
      heartbeatSeconds: 60,
      defaultAgentId: "main",
      agents: [
        {
          agentId: "main",
          isDefault: true,
          heartbeat: {
            enabled: true,
            every: "1m",
            everyMs: 60_000,
            prompt: "hi",
            target: "last",
            ackMaxChars: 160,
          },
          sessions: agentSessions,
        },
      ],
      sessions: agentSessions,
    };
    callGatewayMock.mockResolvedValueOnce(snapshot);

    await healthCommand({ json: true, timeoutMs: 5000 }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    const logged = runtime.log.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(logged) as HealthSummary;
    expect(parsed.channels.whatsapp?.linked).toBe(true);
    expect(parsed.channels.telegram?.configured).toBe(true);
    expect(parsed.sessions.count).toBe(1);
  });

  it("prints text summary when not json", async () => {
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      ts: Date.now(),
      durationMs: 5,
      channels: {
        whatsapp: { accountId: "default", linked: false, authAgeMs: null },
        telegram: { accountId: "default", configured: false },
        discord: { accountId: "default", configured: false },
      },
      channelOrder: ["whatsapp", "telegram", "discord"],
      channelLabels: {
        whatsapp: "WhatsApp",
        telegram: "Telegram",
        discord: "Discord",
      },
      heartbeatSeconds: 60,
      defaultAgentId: "main",
      agents: [
        {
          agentId: "main",
          isDefault: true,
          heartbeat: {
            enabled: true,
            every: "1m",
            everyMs: 60_000,
            prompt: "hi",
            target: "last",
            ackMaxChars: 160,
          },
          sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
        },
      ],
      sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    } satisfies HealthSummary);

    await healthCommand({ json: false }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalled();
  });

  it("formats per-account probe timings", () => {
    const summary: HealthSummary = {
      ok: true,
      ts: Date.now(),
      durationMs: 5,
      channels: {
        telegram: {
          accountId: "main",
          configured: true,
          probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
          accounts: {
            main: {
              accountId: "main",
              configured: true,
              probe: { ok: true, elapsedMs: 196, bot: { username: "pinguini_ugi_bot" } },
            },
            flurry: {
              accountId: "flurry",
              configured: true,
              probe: { ok: true, elapsedMs: 190, bot: { username: "flurry_ugi_bot" } },
            },
            poe: {
              accountId: "poe",
              configured: true,
              probe: { ok: true, elapsedMs: 188, bot: { username: "poe_ugi_bot" } },
            },
          },
        },
      },
      channelOrder: ["telegram"],
      channelLabels: { telegram: "Telegram" },
      heartbeatSeconds: 60,
      defaultAgentId: "main",
      agents: [
        {
          agentId: "main",
          isDefault: true,
          heartbeat: {
            enabled: true,
            every: "1m",
            everyMs: 60_000,
            prompt: "hi",
            target: "last",
            ackMaxChars: 160,
          },
          sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
        },
      ],
      sessions: { path: "/tmp/sessions.json", count: 0, recent: [] },
    };

    const lines = formatHealthChannelLines(summary, { accountMode: "all" });
    expect(lines).toContain(
      "Telegram: ok (@pinguini_ugi_bot:main:196ms, @flurry_ugi_bot:flurry:190ms, @poe_ugi_bot:poe:188ms)",
    );
  });
});
