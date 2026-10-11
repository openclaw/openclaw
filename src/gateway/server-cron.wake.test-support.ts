import { expect, it, type Mock } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { CronServiceState } from "../cron/service/state.js";
import type { buildGatewayCronService } from "./server-cron.js";

type GatewayCronWakeTestHarness = {
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig) => ReturnType<typeof buildGatewayCronService>;
  getCronDeps: (state: ReturnType<typeof buildGatewayCronService>) => {
    enqueueSystemEvent?: (
      ...args: Parameters<CronServiceState["deps"]["enqueueSystemEvent"]>
    ) => unknown;
  };
  enqueueSystemEventMock: Mock;
  enqueueSessionEventMock: Mock;
};

export function registerGatewayCronWakeTests({
  createCronConfig,
  loadCronService,
  getCronDeps,
  enqueueSystemEventMock,
  enqueueSessionEventMock,
}: GatewayCronWakeTestHarness) {
  it("routes relative wake session keys to the configured default agent", async () => {
    const cfg = createCronConfig("server-cron-relative-default");
    cfg.agents = { entries: { primary: { model: "test/primary" } } };
    const state = loadCronService(cfg);
    try {
      getCronDeps(state).enqueueSystemEvent?.("hello", {
        sessionKey: "discord:channel:ops",
        contextKey: "cron:test",
      });
      expect(enqueueSystemEventMock).toHaveBeenCalledExactlyOnceWith(
        "hello",
        expect.objectContaining({
          sessionKey: "agent:primary:discord:channel:ops",
          contextKey: "cron:test",
        }),
      );
      expect(
        await state.cron.wake({ mode: "now", text: "hello", sessionKey: "discord:channel:ops" }),
      ).toEqual({ ok: true });
      expect(enqueueSessionEventMock).toHaveBeenCalledExactlyOnceWith(
        "hello",
        expect.objectContaining({
          source: "cron",
          agentId: "primary",
          sessionKey: "agent:primary:discord:channel:ops",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("rejects unknown agent-prefixed keys instead of rebinding them to the default agent", () => {
    const cfg = createCronConfig("server-cron-unknown-agent");
    cfg.agents = {
      entries: {
        primary: { model: "test/primary" },
        ops: { model: "test/ops" },
      },
    };
    const state = loadCronService(cfg);
    try {
      expect(() =>
        state.cron.wake({
          mode: "now",
          text: "hello",
          sessionKey: "agent:ghost:discord:channel:ops",
        }),
      ).toThrow("cron job agent is unavailable: ghost");
      expect(enqueueSessionEventMock).not.toHaveBeenCalled();
    } finally {
      state.cron.stop();
    }
  });

  it("threads cron wake sessionKey through the CronService adapter", async () => {
    const cfg = createCronConfig("server-cron-wake-service");
    cfg.agents = { entries: { primary: {}, ops: {} } };
    const state = loadCronService(cfg);
    try {
      const sessionKey = "agent:ops:cron:nightly:run:abc-123";
      expect(await state.cron.wake({ mode: "now", text: "hello", sessionKey })).toEqual({
        ok: true,
      });
      expect(enqueueSessionEventMock).toHaveBeenCalledExactlyOnceWith(
        "hello",
        expect.objectContaining({
          source: "cron",
          agentId: "ops",
          sessionKey,
        }),
      );
    } finally {
      state.cron.stop();
    }
  });

  it("routes a targetless cron wake through the configured system agent", async () => {
    const cfg = {
      ...createCronConfig("server-cron-system-owner-wake"),
      agents: {
        defaults: { systemAgent: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    } satisfies OpenClawConfig;
    const state = loadCronService(cfg);
    try {
      expect(await state.cron.wake({ mode: "now", text: "system wake" })).toEqual({ ok: true });
      expect(enqueueSessionEventMock).toHaveBeenCalledExactlyOnceWith(
        "system wake",
        expect.objectContaining({
          agentId: "ops",
          sessionKey: "agent:ops:main",
          source: "cron",
        }),
      );
    } finally {
      state.cron.stop();
    }
  });
}
