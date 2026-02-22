import { beforeEach, describe, expect, it, vi } from "vitest";
import type { getReplyFromConfig } from "../../auto-reply/reply.js";
import { HEARTBEAT_TOKEN } from "../../auto-reply/tokens.js";
import type { sendMessageWhatsApp } from "../outbound.js";

const state = vi.hoisted(() => ({
  visibility: { showAlerts: true, showOk: true, useIndicator: false },
  store: {} as Record<string, { updatedAt?: number; sessionId?: string }>,
  snapshot: {
    key: "k",
    entry: { sessionId: "s1", updatedAt: 123 },
    fresh: false,
    resetPolicy: { mode: "none", atHour: null, idleMinutes: null },
    dailyResetAt: null as number | null,
    idleExpiresAt: null as number | null,
  },
  events: [] as unknown[],
}));

vi.mock("../../agents/current-time.js", () => ({
  appendCronStyleCurrentTimeLine: (body: string) =>
    `${body}\nCurrent time: 2026-02-15T00:00:00Z (mock)`,
}));

// Perf: this module otherwise pulls a large dependency graph that we don't need
// for these unit tests.
vi.mock("../../auto-reply/reply.js", () => ({
  getReplyFromConfig: vi.fn(async () => undefined),
}));

vi.mock("../../channels/plugins/whatsapp-heartbeat.js", () => ({
  resolveWhatsAppHeartbeatRecipients: () => [],
}));

vi.mock("../../config/config.js", () => ({
  loadConfig: () => ({ agents: { defaults: {} }, session: {} }),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeMainKey: () => null,
}));

vi.mock("../../infra/heartbeat-visibility.js", () => ({
  resolveHeartbeatVisibility: () => state.visibility,
}));

vi.mock("../../config/sessions.js", () => ({
  loadSessionStore: () => state.store,
  resolveSessionKey: () => "k",
  resolveStorePath: () => "/tmp/store.json",
  updateSessionStore: async (_path: string, updater: (store: typeof state.store) => void) => {
    updater(state.store);
  },
}));

vi.mock("./session-snapshot.js", () => ({
  getSessionSnapshot: () => state.snapshot,
}));

vi.mock("../../infra/heartbeat-events.js", () => ({
  emitHeartbeatEvent: (event: unknown) => state.events.push(event),
  resolveIndicatorType: (status: string) => `indicator:${status}`,
}));

vi.mock("../../logging.js", () => ({
  getChildLogger: () => ({
    info: () => {},
    warn: () => {},
  }),
}));

vi.mock("./loggers.js", () => ({
  whatsappHeartbeatLog: {
    info: () => {},
    warn: () => {},
  },
}));

vi.mock("../reconnect.js", () => ({
  newConnectionId: () => "run-1",
}));

vi.mock("../outbound.js", () => ({
  sendMessageWhatsApp: vi.fn(async () => ({ messageId: "m1" })),
}));

vi.mock("../session.js", () => ({
  formatError: (err: unknown) => `ERR:${String(err)}`,
}));

describe("runWebHeartbeatOnce", () => {
  let senderMock: ReturnType<typeof vi.fn>;
  let sender: typeof sendMessageWhatsApp;
  let replyResolverMock: ReturnType<typeof vi.fn>;
  let replyResolver: typeof getReplyFromConfig;

  const getModules = async () => await import("./heartbeat-runner.js");
  const buildRunArgs = (overrides: Record<string, unknown> = {}) => ({
    cfg: { agents: { defaults: {} }, session: {} } as never,
    to: "+123",
    sender,
    replyResolver,
    ...overrides,
  });

  beforeEach(() => {
    state.visibility = { showAlerts: true, showOk: true, useIndicator: false };
    state.store = { k: { updatedAt: 999, sessionId: "s1" } };
    state.snapshot = {
      key: "k",
      entry: { sessionId: "s1", updatedAt: 123 },
      fresh: false,
      resetPolicy: { mode: "none", atHour: null, idleMinutes: null },
      dailyResetAt: null,
      idleExpiresAt: null,
    };
    state.events = [];

    senderMock = vi.fn(async () => ({ messageId: "m1" }));
    sender = senderMock as unknown as typeof sendMessageWhatsApp;
    replyResolverMock = vi.fn(async () => undefined);
    replyResolver = replyResolverMock as unknown as typeof getReplyFromConfig;
  });

  it("supports manual override body dry-run without sending", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs({ overrideBody: "hello", dryRun: true }));
    expect(senderMock).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(0);
  });

  it("sends HEARTBEAT_OK when reply is empty and showOk is enabled", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(senderMock).toHaveBeenCalledWith("+123", HEARTBEAT_TOKEN, { verbose: false });
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok-empty", silent: false })]),
    );
  });

  it("injects a cron-style Current time line into the heartbeat prompt", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(
      buildRunArgs({
        cfg: { agents: { defaults: { heartbeat: { prompt: "Ops check" } } }, session: {} } as never,
        dryRun: true,
      }),
    );
    expect(replyResolver).toHaveBeenCalledTimes(1);
    const ctx = replyResolverMock.mock.calls[0]?.[0];
    expect(ctx?.Body).toContain("Ops check");
    expect(ctx?.Body).toContain("Current time: 2026-02-15T00:00:00Z (mock)");
  });

  it("treats heartbeat token-only replies as ok-token and preserves session updatedAt", async () => {
    replyResolverMock.mockResolvedValue({ text: HEARTBEAT_TOKEN });
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(state.store.k?.updatedAt).toBe(123);
    expect(senderMock).toHaveBeenCalledWith("+123", HEARTBEAT_TOKEN, { verbose: false });
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok-token", silent: false })]),
    );
  });

  it("skips sending alerts when showAlerts is disabled but still emits a skipped event", async () => {
    state.visibility = { showAlerts: false, showOk: true, useIndicator: true };
    replyResolverMock.mockResolvedValue({ text: "ALERT" });
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce(buildRunArgs());
    expect(senderMock).not.toHaveBeenCalled();
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", reason: "alerts-disabled", preview: "ALERT" }),
      ]),
    );
  });

  it("emits failed events when sending throws and rethrows the error", async () => {
    replyResolverMock.mockResolvedValue({ text: "ALERT" });
    senderMock.mockRejectedValueOnce(new Error("nope"));
    const { runWebHeartbeatOnce } = await getModules();
    await expect(runWebHeartbeatOnce(buildRunArgs())).rejects.toThrow("nope");
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", reason: "ERR:Error: nope" }),
      ]),
    );
  });
});
