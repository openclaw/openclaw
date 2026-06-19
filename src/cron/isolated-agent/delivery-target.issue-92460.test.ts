import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Issue #92460 regression: an isolated cron's delivery target must survive the
// originating session entry being evicted before completion fires, and the
// shared main session bucket being retargeted by another conversation. The
// task-route lease module (see src/tasks/task-route-lease.ts) captures the
// original outbound origin at job start; the delivery-target resolver must
// consult it as a session-identity fallback.
//
// Coverage:
//   1. lease wins over an EMPTY main session (the typical evicted-session case)
//   2. lease wins over a STALE main session whose lastChannel/lastTo point to
//      a different conversation (the retargeted-shared-bucket case)
//   3. lease takes lower precedence than the per-job stored delivery context
//      (i.e. it is a fallback, not a primary source)
//   4. lease takes lower precedence than the per-thread session entry
//      (i.e. it is a fallback, not a primary source)
//   5. a keyless cron that would have been refused by the #91613 inherited-
//      room check is DELIVERED when the lease carries an explicit origin
//      (the originating origin is no longer "inherited from the shared bucket")
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelOutboundAdapter } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import {
  parseTelegramTargetForTest,
  telegramMessagingForTest,
} from "../../infra/outbound/targets.test-helpers.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  closeOpenClawStateDatabase,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  acquireTaskRouteLease,
  resetTaskRouteLeasesForTests,
} from "../../tasks/task-route-lease.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";

const { extractDeliveryInfoMock } = vi.hoisted(() => ({
  extractDeliveryInfoMock: vi.fn(),
}));

vi.mock("../../config/sessions/main-session.js", () => ({
  canonicalizeMainSessionAlias: vi.fn(({ sessionKey }) => sessionKey),
  resolveAgentMainSessionKey: vi.fn().mockReturnValue("agent:test:main"),
}));

vi.mock("../../config/sessions/delivery-info.js", () => ({
  extractDeliveryInfo: extractDeliveryInfoMock,
}));

vi.mock("../../config/sessions/paths.js", () => ({
  resolveStorePath: vi.fn().mockReturnValue("/tmp/test-store.json"),
}));

vi.mock("../../config/sessions/session-accessor.js", () => ({
  loadSessionEntry: vi.fn(),
}));

vi.mock("../../infra/outbound/channel-selection.runtime.js", () => ({
  resolveMessageChannelSelection: vi
    .fn()
    .mockResolvedValue({ channel: "telegram", configured: ["telegram"] }),
}));

vi.mock("../../infra/outbound/target-id-resolution.js", () => ({
  maybeResolveIdLikeTarget: vi.fn(),
}));

vi.mock("../../infra/outbound/targets.runtime.js", () => ({
  resolveOutboundTarget: vi.fn(),
}));

const mockedModuleIds = [
  "../../config/sessions/main-session.js",
  "../../config/sessions/delivery-info.js",
  "../../config/sessions/paths.js",
  "../../config/sessions/session-accessor.js",
  "../../infra/outbound/channel-selection.runtime.js",
  "../../infra/outbound/targets.runtime.js",
  "../../infra/outbound/target-id-resolution.js",
];

import { loadSessionEntry } from "../../config/sessions/session-accessor.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.runtime.js";
import { resolveDeliveryTarget } from "./delivery-target.js";

afterAll(() => {
  for (const id of mockedModuleIds) {
    vi.doUnmock(id);
  }
  vi.resetModules();
});

function createStubOutbound(label: string): ChannelOutboundAdapter {
  return {
    deliveryMode: "gateway",
    resolveTarget: ({ to }) => {
      const trimmed = typeof to === "string" ? to.trim() : "";
      return trimmed
        ? { ok: true, to: trimmed }
        : { ok: false, error: new Error(`${label} requires target`) };
    },
  };
}

const normalizeTelegramTargetForDeliveryTest = vi.fn((raw: string): string | undefined => {
  const target = parseTelegramTargetForTest(raw);
  if (!target.chatId) {
    return undefined;
  }
  const normalizedTo = target.chatId.toLowerCase();
  return target.messageThreadId == null
    ? `telegram:${normalizedTo}`
    : `telegram:${normalizedTo}:topic:${target.messageThreadId}`;
});

function createTempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-92460-test-"));
}

function makeCfg(overrides?: Partial<OpenClawConfig>): OpenClawConfig {
  return {
    bindings: [],
    channels: {},
    ...overrides,
  } as OpenClawConfig;
}

const AGENT_ID = "agent-b";

type SessionStore = Record<string, SessionEntry>;

function setSessionStore(store: SessionStore) {
  vi.mocked(loadSessionEntry).mockImplementation(({ sessionKey }) => store[sessionKey]);
}

beforeEach(() => {
  resetPluginRuntimeStateForTest();
  resetTaskRouteLeasesForTests();
  extractDeliveryInfoMock.mockReset();
  extractDeliveryInfoMock.mockReturnValue({ deliveryContext: undefined, threadId: undefined });
  vi.mocked(resolveOutboundTarget).mockReset();
  vi.mocked(loadSessionEntry).mockReset().mockReturnValue(undefined);
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createOutboundTestPlugin({
          id: "telegram",
          outbound: createStubOutbound("Telegram"),
          messaging: {
            ...telegramMessagingForTest,
            normalizeTarget: normalizeTelegramTargetForDeliveryTest,
          },
        }),
        source: "test",
      },
    ]),
  );
});

afterEach(() => {
  resetPluginRuntimeStateForTest();
  try {
    closeOpenClawStateDatabase();
  } catch {
    // noop
  }
});

const LEASE_ORIGIN_TELEGRAM = {
  channel: "telegram",
  to: "100200300",
  accountId: "default",
  threadId: undefined,
};

const RUN_ID = "run-92460-test";

describe("resolveDeliveryTarget — issue #92460 task-route lease fallback", () => {
  it("uses the lease origin when the originating session entry was evicted (no main session)", async () => {
    const stateDir = createTempStateDir();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    acquireTaskRouteLease({
      runId: RUN_ID,
      taskId: "task-92460-evicted",
      requesterOrigin: LEASE_ORIGIN_TELEGRAM,
      ttlMs: 60_000,
    });
    // loadSessionEntry returns undefined for every key (session evicted).
    setSessionStore({});

    const result = await resolveDeliveryTarget(makeCfg({ channels: { telegram: {} } }), AGENT_ID, {
      channel: "last",
      to: undefined,
      runId: RUN_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channel).toBe("telegram");
      expect(result.to).toBe("100200300");
    }
  });

  it("uses the lease origin when the shared main bucket was retargeted to a different conversation", async () => {
    // A different conversation has retargeted the shared agent-main bucket.
    // Its lastTo is a different room; without the lease, the resolver would
    // either inherit that wrong room or refuse the cron entirely.
    const stateDir = createTempStateDir();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    acquireTaskRouteLease({
      runId: RUN_ID,
      taskId: "task-92460-retargeted",
      requesterOrigin: LEASE_ORIGIN_TELEGRAM,
      ttlMs: 60_000,
    });
    setSessionStore({
      "agent:test:main": {
        sessionId: "sess-other-conversation",
        updatedAt: 1000,
        lastChannel: "telegram",
        lastTo: "999888777", // WRONG room — another conversation's room.
        lastAccountId: "default",
      },
    });

    const result = await resolveDeliveryTarget(makeCfg({ channels: { telegram: {} } }), AGENT_ID, {
      channel: "last",
      to: undefined,
      runId: RUN_ID,
    });

    // Without the lease, the resolver would refuse this cron (see #91613).
    // With the lease, the originating origin wins, so the cron delivers to
    // its captured room — not the other conversation's.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.channel).toBe("telegram");
      expect(result.to).toBe("100200300");
    }
  });

  it("stored delivery context takes precedence over the lease (lease is a fallback)", async () => {
    // When the job carries a per-thread stored delivery context (set via cron
    // create/edit), the stored context wins; the lease is only consulted when
    // the higher-precedence sources are missing.
    const stateDir = createTempStateDir();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    acquireTaskRouteLease({
      runId: RUN_ID,
      taskId: "task-92460-stored-wins",
      requesterOrigin: LEASE_ORIGIN_TELEGRAM,
      ttlMs: 60_000,
    });
    setSessionStore({});
    // extractDeliveryInfo returns a stored delivery context for the thread session key.
    extractDeliveryInfoMock.mockReturnValue({
      deliveryContext: {
        channel: "telegram",
        to: "stored-room-555",
        accountId: "default",
      },
      threadId: undefined,
    });

    const result = await resolveDeliveryTarget(makeCfg({ channels: { telegram: {} } }), AGENT_ID, {
      channel: "last",
      to: undefined,
      sessionKey: "agent:test:thread:abc",
      runId: RUN_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stored context wins.
      expect(result.to).toBe("stored-room-555");
    }
  });

  it("thread session entry takes precedence over the lease (lease is a fallback)", async () => {
    // When the job's own thread session has a recorded lastChannel/lastTo,
    // that session entry wins over the lease. The lease is the LAST fallback
    // before the shared main session bucket.
    const stateDir = createTempStateDir();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    acquireTaskRouteLease({
      runId: RUN_ID,
      taskId: "task-92460-thread-wins",
      requesterOrigin: LEASE_ORIGIN_TELEGRAM,
      ttlMs: 60_000,
    });
    setSessionStore({
      "agent:test:thread:abc": {
        sessionId: "sess-thread-abc",
        updatedAt: 1000,
        lastChannel: "telegram",
        lastTo: "thread-room-777",
        lastAccountId: "default",
      },
    });

    const result = await resolveDeliveryTarget(makeCfg({ channels: { telegram: {} } }), AGENT_ID, {
      channel: "last",
      to: undefined,
      sessionKey: "agent:test:thread:abc",
      runId: RUN_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Thread session wins over lease.
      expect(result.to).toBe("thread-room-777");
    }
  });

  it("keyless cron delivers via lease origin instead of being refused (#91613 interaction)", async () => {
    // The shared bucket was retargeted by another conversation. Without the
    // lease, the resolver would refuse this keyless cron (see #91613). With
    // the lease carrying the originating origin, the cron is delivered.
    const stateDir = createTempStateDir();
    openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: stateDir } });
    acquireTaskRouteLease({
      runId: RUN_ID,
      taskId: "task-92460-keyless",
      requesterOrigin: LEASE_ORIGIN_TELEGRAM,
      ttlMs: 60_000,
    });
    setSessionStore({
      "agent:test:main": {
        sessionId: "sess-other-conversation",
        updatedAt: 1000,
        lastChannel: "telegram",
        lastTo: "999888777",
        lastAccountId: "default",
      },
    });

    const result = await resolveDeliveryTarget(makeCfg({ channels: { telegram: {} } }), AGENT_ID, {
      channel: "last",
      to: undefined,
      runId: RUN_ID,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.to).toBe("100200300");
    }
  });
});
