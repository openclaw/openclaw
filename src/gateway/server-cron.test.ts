import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { SsrFBlockedError } from "../infra/net/ssrf.js";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const {
  enqueueSystemEventMock,
  requestHeartbeatNowMock,
  loadConfigMock,
  fetchWithSsrFGuardMock,
  runCronIsolatedAgentTurnMock,
  cleanupBrowserSessionsForLifecycleEndMock,
} = vi.hoisted(() => ({
  enqueueSystemEventMock: vi.fn(),
  requestHeartbeatNowMock: vi.fn(),
  loadConfigMock: vi.fn(),
  fetchWithSsrFGuardMock: vi.fn(),
  runCronIsolatedAgentTurnMock: vi.fn(async () => ({ status: "ok" as const, summary: "ok" })),
  cleanupBrowserSessionsForLifecycleEndMock: vi.fn(async () => {}),
}));

function enqueueSystemEvent(...args: unknown[]) {
  return enqueueSystemEventMock(...args);
}

function requestHeartbeatNow(...args: unknown[]) {
  return requestHeartbeatNowMock(...args);
}

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent,
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeatNow,
    }),
  );
});

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    loadConfig: () => loadConfigMock(),
  };
});

vi.mock("../infra/net/fetch-guard.js", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

vi.mock("../cron/isolated-agent.js", () => ({
  runCronIsolatedAgentTurn: runCronIsolatedAgentTurnMock,
}));

vi.mock("../browser-lifecycle-cleanup.js", () => ({
  cleanupBrowserSessionsForLifecycleEnd: cleanupBrowserSessionsForLifecycleEndMock,
}));

import { buildGatewayCronService } from "./server-cron.js";

function createCronConfig(name: string): OpenClawConfig {
  const tmpDir = path.join(os.tmpdir(), `${name}-${Date.now()}`);
  return {
    session: {
      mainKey: "main",
    },
    cron: {
      store: path.join(tmpDir, "cron.json"),
    },
  } as OpenClawConfig;
}

describe("buildGatewayCronService", () => {
  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatNowMock.mockClear();
    loadConfigMock.mockClear();
    fetchWithSsrFGuardMock.mockClear();
    runCronIsolatedAgentTurnMock.mockClear();
    cleanupBrowserSessionsForLifecycleEndMock.mockClear();
  });

  it("routes main-target jobs to the scoped session for enqueue + wake", async () => {
    const cfg = createCronConfig("server-cron");
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
    const cfg = createCronConfig("server-cron-ssrf");
    loadConfigMock.mockReturnValue(cfg);
    fetchWithSsrFGuardMock.mockRejectedValue(
      new SsrFBlockedError("Blocked: resolves to private/internal/special-use IP address"),
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

  it("passes custom session targets through to isolated cron runs", async () => {
    const tmpDir = path.join(os.tmpdir(), `server-cron-custom-session-${Date.now()}`);
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
        name: "custom-session",
        enabled: true,
        schedule: { kind: "at", at: new Date(1).toISOString() },
        sessionTarget: "session:project-alpha-monitor",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "hello" },
      });

      await state.cron.run(job.id, "force");

      expect(runCronIsolatedAgentTurnMock).toHaveBeenCalledWith(
        expect.objectContaining({
          job: expect.objectContaining({ id: job.id }),
          sessionKey: "project-alpha-monitor",
        }),
      );
      expect(cleanupBrowserSessionsForLifecycleEndMock).toHaveBeenCalledWith({
        sessionKeys: ["project-alpha-monitor"],
        onWarn: expect.any(Function),
      });
    } finally {
      state.cron.stop();
    }
  });
});
