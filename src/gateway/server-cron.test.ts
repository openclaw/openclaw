import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatNowMock = vi.fn();
const loadConfigMock = vi.fn();
const fetchWithSsrFGuardMock = vi.fn();
const deliverOutboundPayloadsMock = vi.fn();
const resolveDeliveryTargetMock = vi.fn();
const cronLoggerWarnMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", () => ({
  requestHeartbeatNow: (...args: unknown[]) => requestHeartbeatNowMock(...args),
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: (...args: unknown[]) => fetchWithSsrFGuardMock(...args),
}));

vi.mock("../infra/outbound/deliver.js", () => ({
  deliverOutboundPayloads: (...args: unknown[]) => deliverOutboundPayloadsMock(...args),
}));

vi.mock("../cron/isolated-agent/delivery-target.js", () => ({
  resolveDeliveryTarget: (...args: unknown[]) => resolveDeliveryTargetMock(...args),
}));

vi.mock("../logging.js", async () => {
  const actual = await vi.importActual<typeof import("../logging.js")>("../logging.js");
  return {
    ...actual,
    getChildLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => cronLoggerWarnMock(...args),
      error: vi.fn(),
    }),
  };
});

import { buildGatewayCronService } from "./server-cron.js";

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockReset();
    requestHeartbeatNowMock.mockReset();
    loadConfigMock.mockReset();
    fetchWithSsrFGuardMock.mockReset();
    deliverOutboundPayloadsMock.mockReset();
    resolveDeliveryTargetMock.mockReset();
    cronLoggerWarnMock.mockReset();
    resolveDeliveryTargetMock.mockResolvedValue({
      channel: "telegram",
      to: "123",
      mode: "explicit",
      accountId: undefined,
      threadId: undefined,
    });
  });

  it("canonicalizes non-agent sessionKey to agent store key for enqueue + wake", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "canonicalize-session-key",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        sessionKey: "discord:channel:ops",
        payload: { kind: "systemEvent", text: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(enqueueSystemEventMock).toHaveBeenCalledWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
      expect(requestHeartbeatNowMock).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionKey: "agent:main:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("blocks private webhook URLs via SSRF-guarded fetch", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-ssrf-${Date.now()}`);
    const cfg = {
      session: {
        mainKey: "main",
      },
      cron: {
        store: path.join(tmpDir, "cron.json"),
      },
    } as OpenClawConfig;

    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: private/internal IP address"),
    );

    const state = buildGatewayCronService({
      cfg,
      deps: {} as CliDeps,
      broadcast: () => {},
    });
    try {
      const job = await state.cron.add({
        name: "ssrf-webhook-blocked",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "hello" },
        delivery: {
          mode: "webhook",
          to: "http://127.0.0.1:8080/cron-finished",
        },
      });

      await state.cron.run(job.id, "force");

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith({
        url: "http://127.0.0.1:8080/cron-finished",
        init: {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: expect.stringContaining('"action":"finished"'),
          signal: expect.any(AbortSignal),
        },
      });
    } finally {
      state.cron.stop();
    }
  });

  it("delivers direct-command announce output via cron delivery settings", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: { mainKey: "main" },
      cron: { store: path.join(tmpDir, "cron.json") },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);

    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast: () => {} });
    try {
      const job = await state.cron.add({
        name: "direct-delivery",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        delivery: { mode: "announce", channel: "telegram", to: "123" },
        payload: {
          kind: "directCommand",
          command: process.execPath,
          args: ["-e", "process.stdout.write('hi')"],
        },
      });

      await state.cron.run(job.id, "force");

      expect(resolveDeliveryTargetMock).toHaveBeenCalledTimes(1);
      expect(deliverOutboundPayloadsMock).toHaveBeenCalledTimes(1);
      const payloadText = deliverOutboundPayloadsMock.mock.calls[0]?.[0]?.payloads?.[0]?.text;
      expect(payloadText).toContain('"status":"ok"');
      expect(payloadText).toContain('"stdout":"hi"');
    } finally {
      state.cron.stop();
    }
  });

  it("marks direct-command summary result status as error when announce delivery fails", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: { mainKey: "main" },
      cron: { store: path.join(tmpDir, "cron.json") },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    deliverOutboundPayloadsMock.mockRejectedValue(new Error("send failed"));

    const broadcastMock = vi.fn();
    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast: broadcastMock });
    try {
      const job = await state.cron.add({
        name: "direct-delivery-fail",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        delivery: { mode: "announce", channel: "telegram", to: "123" },
        payload: {
          kind: "directCommand",
          command: process.execPath,
          args: ["-e", "process.stdout.write('hi')"],
        },
      });

      await state.cron.run(job.id, "force");

      const finishedEvent = broadcastMock.mock.calls
        .map(
          (call) =>
            call[1] as {
              action?: string;
              status?: string;
              summary?: string;
              error?: string;
            },
        )
        .find((evt) => evt?.action === "finished");
      expect(finishedEvent).toBeDefined();
      expect(finishedEvent?.status).toBe("error");
      expect(finishedEvent?.error).toContain("send failed");

      const parsed = JSON.parse(finishedEvent?.summary ?? "{}") as {
        status: string;
        captured?: { stdout?: string };
      };
      expect(parsed.status).toBe("error");
      expect(parsed.captured?.stdout).toContain("hi");
    } finally {
      state.cron.stop();
    }
  });

  it("logs best-effort warning and preserves direct-command status when delivery send fails", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-${Date.now()}`);
    const cfg = {
      session: { mainKey: "main" },
      cron: { store: path.join(tmpDir, "cron.json") },
    } as OpenClawConfig;
    loadConfigMock.mockReturnValue(cfg);
    deliverOutboundPayloadsMock.mockRejectedValue(new Error("best effort send failed"));

    const broadcastMock = vi.fn();
    const state = buildGatewayCronService({ cfg, deps: {} as CliDeps, broadcast: broadcastMock });
    try {
      const job = await state.cron.add({
        name: "direct-delivery-best-effort-fail",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        delivery: { mode: "announce", channel: "telegram", to: "123", bestEffort: true },
        payload: {
          kind: "directCommand",
          command: process.execPath,
          args: ["-e", "process.stdout.write('hi')"],
        },
      });

      await state.cron.run(job.id, "force");

      const finishedEvent = broadcastMock.mock.calls
        .map(
          (call) =>
            call[1] as {
              action?: string;
              status?: string;
            },
        )
        .find((evt) => evt?.action === "finished");
      expect(finishedEvent?.status).toBe("ok");
      expect(cronLoggerWarnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          err: expect.stringContaining("best effort send failed"),
          jobId: job.id,
        }),
        "cron: direct command delivery failed (best-effort)",
      );
    } finally {
      state.cron.stop();
    }
  });
});
