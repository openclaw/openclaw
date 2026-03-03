import { beforeEach, describe, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { stripAnsi } from "../terminal/ansi.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import type { HealthSummary } from "./health.js";
import { healthCommand } from "./health.js";

const callGatewayMock = vi.fn();
const logWebSelfIdMock = vi.fn();

function createRecentSessionRows(now = Date.now()) {
  return [
    { key: "main", updatedAt: now - 60_000, age: 60_000 },
    { key: "foo", updatedAt: null, age: null },
  ];
}

vi.mock("../gateway/call.js", () => ({
  callGateway: (...args: unknown[]) => callGatewayMock(...args),
}));

vi.mock("../web/auth-store.js", () => ({
  webAuthExists: vi.fn(async () => true),
  getWebAuthAgeMs: vi.fn(() => 0),
  logWebSelfId: (...args: unknown[]) => logWebSelfIdMock(...args),
}));

describe("healthCommand (coverage)", () => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "whatsapp",
          source: "test",
          plugin: {
            id: "whatsapp",
            meta: {
              id: "whatsapp",
              label: "WhatsApp",
              selectionLabel: "WhatsApp",
              docsPath: "/channels/whatsapp",
              blurb: "WhatsApp test stub.",
            },
            capabilities: { chatTypes: ["direct", "group"] },
            config: {
              listAccountIds: () => ["default"],
              resolveAccount: () => ({}),
            },
            status: {
              logSelfId: () => logWebSelfIdMock(),
            },
          },
        },
      ]),
    );
  });

  it("prints the rich text summary when linked and configured", async () => {
    const recent = createRecentSessionRows();
    callGatewayMock.mockResolvedValueOnce({
      ok: true,
      ts: Date.now(),
      durationMs: 5,
      channels: {
        whatsapp: {
          accountId: "default",
          linked: true,
          authAgeMs: 5 * 60_000,
        },
        telegram: {
          accountId: "default",
          configured: true,
          probe: {
            ok: true,
            elapsedMs: 7,
            bot: { username: "bot" },
            webhook: { url: "https://example.com/h" },
          },
        },
        discord: {
          accountId: "default",
          configured: false,
        },
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
          sessions: {
            path: "/tmp/sessions.json",
            count: 2,
            recent,
          },
        },
      ],
      sessions: {
        path: "/tmp/sessions.json",
        count: 2,
        recent,
      },
    } satisfies HealthSummary);

    await healthCommand({ json: false, timeoutMs: 1000 }, runtime as never);

    expect(runtime.exit).not.toHaveBeenCalled();
    expect(stripAnsi(runtime.log.mock.calls.map((c) => String(c[0])).join("\n"))).toMatch(
      /WhatsApp: linked/i,
    );
    expect(logWebSelfIdMock).toHaveBeenCalled();
  });
});
