import { beforeEach, describe, expect, it, vi } from "vitest";
import { HEARTBEAT_TOKEN } from "../../auto-reply/tokens.js";

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
  appendCronStyleCurrentTimeLine: (body: string) => body,
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
  let sender: ReturnType<typeof vi.fn>;
  let replyResolver: ReturnType<typeof vi.fn>;

  const getModules = async () => await import("./heartbeat-runner.js");

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

    sender = vi.fn(async () => ({ messageId: "m1" }));
    replyResolver = vi.fn(async () => undefined);
  });

  it("supports manual override body dry-run without sending", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce({
      cfg: { agents: { defaults: {} }, session: {} } as never,
      to: "+123",
      sender,
      replyResolver,
      overrideBody: "hello",
      dryRun: true,
    });
    expect(sender).not.toHaveBeenCalled();
    expect(state.events).toHaveLength(0);
  });

  it("sends HEARTBEAT_OK when reply is empty and showOk is enabled", async () => {
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce({
      cfg: { agents: { defaults: {} }, session: {} } as never,
      to: "+123",
      sender,
      replyResolver,
    });
    expect(sender).toHaveBeenCalledWith("+123", HEARTBEAT_TOKEN, { verbose: false });
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok-empty", silent: false })]),
    );
  });

  it("treats heartbeat token-only replies as ok-token and preserves session updatedAt", async () => {
    replyResolver.mockResolvedValue({ text: HEARTBEAT_TOKEN });
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce({
      cfg: { agents: { defaults: {} }, session: {} } as never,
      to: "+123",
      sender,
      replyResolver,
    });
    expect(state.store.k?.updatedAt).toBe(123);
    expect(sender).toHaveBeenCalledWith("+123", HEARTBEAT_TOKEN, { verbose: false });
    expect(state.events).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "ok-token", silent: false })]),
    );
  });

  it("skips sending alerts when showAlerts is disabled but still emits a skipped event", async () => {
    state.visibility = { showAlerts: false, showOk: true, useIndicator: true };
    replyResolver.mockResolvedValue({ text: "ALERT" });
    const { runWebHeartbeatOnce } = await getModules();
    await runWebHeartbeatOnce({
      cfg: { agents: { defaults: {} }, session: {} } as never,
      to: "+123",
      sender,
      replyResolver,
    });
    expect(sender).not.toHaveBeenCalled();
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "skipped", reason: "alerts-disabled", preview: "ALERT" }),
      ]),
    );
  });

  it("emits failed events when sending throws and rethrows the error", async () => {
    replyResolver.mockResolvedValue({ text: "ALERT" });
    sender.mockRejectedValueOnce(new Error("nope"));
    const { runWebHeartbeatOnce } = await getModules();
    await expect(
      runWebHeartbeatOnce({
        cfg: { agents: { defaults: {} }, session: {} } as never,
        to: "+123",
        sender,
        replyResolver,
      }),
    ).rejects.toThrow("nope");
    expect(state.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ status: "failed", reason: "ERR:Error: nope" }),
      ]),
    );
  });
});
