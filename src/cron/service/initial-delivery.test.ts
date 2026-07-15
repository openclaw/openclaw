import { describe, expect, it, vi } from "vitest";
import { CronService } from "../service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "../service.test-harness.js";
import type { CronDelivery, CronJobCreate, CronSchedule } from "../types.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";

const schedule: CronSchedule = { kind: "at", at: "2026-01-01T00:00:00Z" };
const everyMinute: CronSchedule = { kind: "every", everyMs: 60_000 };

function agentTurn(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "test-agent",
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "now",
    failureAlert: false,
    payload: { kind: "agentTurn", message: "hello" },
    ...overrides,
  };
}

function command(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "test-cmd",
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "now",
    failureAlert: false,
    payload: { kind: "command", argv: ["echo", "hi"] },
    ...overrides,
  };
}

function systemEvent(overrides: Partial<CronJobCreate> = {}): CronJobCreate {
  return {
    name: "test-event",
    enabled: true,
    schedule,
    sessionTarget: "main",
    wakeMode: "now",
    failureAlert: false,
    payload: { kind: "systemEvent", text: "boot" },
    ...overrides,
  };
}

describe("resolveInitialCronDelivery", () => {
  it("returns explicit delivery unchanged", () => {
    const delivery: CronDelivery = { mode: "webhook", to: "https://example.com/hook" };
    expect(resolveInitialCronDelivery(agentTurn({ delivery }))).toBe(delivery);
  });

  // isolated
  it("defaults to announce for isolated agentTurn", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "isolated" }))).toEqual({
      mode: "announce",
    });
  });

  it("defaults to announce for isolated command", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "isolated" }))).toEqual({
      mode: "announce",
    });
  });

  // current
  it("defaults to announce for current agentTurn", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "current" }))).toEqual({
      mode: "announce",
    });
  });

  it("defaults to announce for current command", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "current" }))).toEqual({
      mode: "announce",
    });
  });

  // session:<id>
  it("defaults to announce for session:<id> agentTurn", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "session:abc-123" }))).toEqual({
      mode: "announce",
    });
  });

  it("defaults to announce for session:<id> command", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "session:abc-123" }))).toEqual({
      mode: "announce",
    });
  });

  // main
  it("returns undefined for main agentTurn (no default delivery)", () => {
    expect(resolveInitialCronDelivery(agentTurn({ sessionTarget: "main" }))).toBeUndefined();
  });

  it("returns undefined for main command (no default delivery)", () => {
    expect(resolveInitialCronDelivery(command({ sessionTarget: "main" }))).toBeUndefined();
  });

  // systemEvent never gets auto-delivery
  it("returns undefined for isolated systemEvent", () => {
    expect(resolveInitialCronDelivery(systemEvent({ sessionTarget: "isolated" }))).toBeUndefined();
  });

  it("returns undefined for current systemEvent", () => {
    expect(resolveInitialCronDelivery(systemEvent({ sessionTarget: "current" }))).toBeUndefined();
  });

  it("returns undefined for session:<id> systemEvent", () => {
    expect(
      resolveInitialCronDelivery(systemEvent({ sessionTarget: "session:abc-123" })),
    ).toBeUndefined();
  });
});

// Direct-service callers (CronService.add createJob and declarative convergence via
// applyDeclarativeJobSpec) bypass normalizeCronJobCreate, so the service-level default
// is the only announce default they get; exercise both through the public add contract.
const logger = createNoopLogger();
const { makeStorePath } = createCronStoreHarness({ prefix: "openclaw-cron-initial-delivery-" });
installCronTestHooks({ logger });

function createDirectCronService(storePath: string) {
  return new CronService({
    storePath,
    cronEnabled: true,
    log: logger,
    enqueueSystemEvent: vi.fn(),
    requestHeartbeat: vi.fn(),
    runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
  });
}

describe("CronService direct-service delivery defaults", () => {
  it.each(["current", "session:abc-123"] as const)(
    "persists announce delivery for direct add with sessionTarget %s",
    async (sessionTarget) => {
      const { storePath } = await makeStorePath();
      const cron = createDirectCronService(storePath);
      await cron.start();

      try {
        const added = await cron.add(agentTurn({ sessionTarget, schedule: everyMinute }));
        expect(added.delivery).toEqual({ mode: "announce" });
        await expect(cron.readJob(added.id)).resolves.toMatchObject({
          delivery: { mode: "announce" },
        });
      } finally {
        cron.stop();
      }
    },
  );

  it("persists no delivery for direct add of a main systemEvent job", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add(systemEvent({ schedule: everyMinute }));
      expect(added.delivery).toBeUndefined();
      await expect(cron.readJob(added.id)).resolves.toMatchObject({
        delivery: undefined,
      });
    } finally {
      cron.stop();
    }
  });

  it("keeps announce delivery when a session: declaration converges", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();

    const declaration = agentTurn({
      declarationKey: "agent:ops:initial-delivery",
      sessionTarget: "session:abc-123",
      schedule: everyMinute,
    });
    try {
      const created = await cron.add(declaration);
      expect(created).toMatchObject({ delivery: { mode: "announce" } });

      const converged = await cron.add(declaration, { enabledExplicit: true });
      if (!("job" in converged)) {
        throw new Error("expected declarative cron result");
      }
      expect(converged).toMatchObject({
        created: false,
        updated: false,
        job: { delivery: { mode: "announce" } },
      });
      const persisted = await cron.readJob(converged.job.id);
      expect(persisted?.delivery).toEqual({ mode: "announce" });
    } finally {
      cron.stop();
    }
  });
});
