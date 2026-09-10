import { describe, expect, it, vi } from "vitest";
import { CronService } from "../service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  installCronTestHooks,
} from "../service.test-harness.js";
import { loadCronStore } from "../store.js";
import type { CronDelivery, CronJob, CronJobCreate } from "../types.js";
import { resolveInitialCronDelivery } from "./initial-delivery.js";

function createInput(params: {
  sessionTarget: CronJobCreate["sessionTarget"];
  payload: CronJobCreate["payload"];
  delivery?: CronDelivery;
}): CronJobCreate {
  return {
    name: "initial delivery",
    enabled: true,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: params.sessionTarget,
    wakeMode: "now",
    failureAlert: false,
    payload: params.payload,
    delivery: params.delivery,
  };
}

describe("resolveInitialCronDelivery", () => {
  it("preserves explicit delivery", () => {
    const delivery: CronDelivery = { mode: "none" };
    expect(
      resolveInitialCronDelivery(
        createInput({
          sessionTarget: "current",
          payload: { kind: "agentTurn", message: "hello" },
          delivery,
        }),
      ),
    ).toBe(delivery);
  });

  it.each(["isolated", "current", "session:project-alpha"] as const)(
    "defaults %s output jobs to announce",
    (sessionTarget) => {
      const payloads: CronJobCreate["payload"][] = [
        { kind: "agentTurn", message: "hello" },
        { kind: "command", argv: ["echo", "hello"] },
        { kind: "script", script: "return { notify: 'hello' }" },
      ];
      for (const payload of payloads) {
        expect(resolveInitialCronDelivery(createInput({ sessionTarget, payload }))).toEqual({
          mode: "announce",
        });
      }
    },
  );

  it("does not default main-session output or system-event delivery", () => {
    expect(
      resolveInitialCronDelivery(
        createInput({ sessionTarget: "main", payload: { kind: "agentTurn", message: "hello" } }),
      ),
    ).toBeUndefined();
    expect(
      resolveInitialCronDelivery(
        createInput({ sessionTarget: "isolated", payload: { kind: "systemEvent", text: "tick" } }),
      ),
    ).toBeUndefined();
  });
});

// Direct service callers do not pass through normalizeCronJobCreate, so keep
// the public add and declarative convergence paths pinned to the same default.
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

describe("CronService initial delivery", () => {
  it("persists Telegram topic delivery without a duplicate threadId", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add(
        createInput({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "hello" },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "telegram:-1001234567890:topic:99",
            threadId: "99",
          },
        }),
      );

      expect(added.delivery).toEqual({
        mode: "announce",
        channel: "telegram",
        to: "telegram:-1001234567890:topic:99",
      });
      await expect(loadCronStore(storePath)).resolves.toMatchObject({
        jobs: [{ delivery: added.delivery }],
      });
    } finally {
      cron.stop();
    }
  });

  it("normalizes Telegram numeric topic shorthand during creation", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add(
        createInput({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "hello" },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "-1001234567890:99",
            threadId: 99,
          },
        }),
      );

      expect(added.delivery).toEqual({
        mode: "announce",
        channel: "telegram",
        to: "-1001234567890:99",
      });
    } finally {
      cron.stop();
    }
  });

  it("preserves an independent thread for a provider-prefixed chat target", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add(
        createInput({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "hello" },
          delivery: {
            mode: "announce",
            channel: "telegram",
            to: "telegram:12345",
            threadId: "12345",
          },
        }),
      );

      expect(added.delivery).toEqual({
        mode: "announce",
        channel: "telegram",
        to: "telegram:12345",
        threadId: "12345",
      });
    } finally {
      cron.stop();
    }
  });

  it("normalizes legacy split Telegram topic routing during an unrelated update", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add(
        createInput({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "hello" },
        }),
      );
      const legacy = cron.getJob(added.id) as CronJob;
      legacy.delivery = {
        mode: "announce",
        channel: "telegram",
        to: "telegram:-1001234567890:topic:99",
        threadId: "99",
      };

      const updated = await cron.update(added.id, { name: "updated topic job" });

      expect(updated.delivery).toEqual({
        mode: "announce",
        channel: "telegram",
        to: "telegram:-1001234567890:topic:99",
      });
      await expect(loadCronStore(storePath)).resolves.toMatchObject({
        jobs: [{ name: "updated topic job", delivery: updated.delivery }],
      });
    } finally {
      cron.stop();
    }
  });

  it("preserves a differing explicit Telegram topic during an unrelated update", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();

    try {
      const added = await cron.add(
        createInput({
          sessionTarget: "isolated",
          payload: { kind: "agentTurn", message: "hello" },
        }),
      );
      const legacy = cron.getJob(added.id) as CronJob;
      legacy.delivery = {
        mode: "announce",
        channel: "telegram",
        to: "telegram:-1001234567890:topic:99",
        threadId: "42",
      };

      const updated = await cron.update(added.id, { name: "updated override job" });

      expect(updated.delivery).toEqual({
        mode: "announce",
        channel: "telegram",
        to: "telegram:-1001234567890:topic:99",
        threadId: "42",
      });
    } finally {
      cron.stop();
    }
  });

  it.each(["current", "session:project-alpha"] as const)(
    "persists announce delivery for direct %s jobs",
    async (sessionTarget) => {
      const { storePath } = await makeStorePath();
      const cron = createDirectCronService(storePath);
      await cron.start();

      try {
        const added = await cron.add(
          createInput({ sessionTarget, payload: { kind: "agentTurn", message: "hello" } }),
        );
        expect(added.delivery).toEqual({ mode: "announce" });
        await expect(cron.readJob(added.id)).resolves.toMatchObject({
          delivery: { mode: "announce" },
        });
      } finally {
        cron.stop();
      }
    },
  );

  it("keeps announce delivery when a declaration converges", async () => {
    const { storePath } = await makeStorePath();
    const cron = createDirectCronService(storePath);
    await cron.start();
    const declaration = {
      ...createInput({
        sessionTarget: "session:project-alpha",
        payload: { kind: "agentTurn", message: "hello" },
      }),
      declarationKey: "agent:ops:initial-delivery",
    };

    try {
      const created = await cron.add(declaration);
      expect(created.delivery).toEqual({ mode: "announce" });

      const converged = await cron.add(declaration, { enabledExplicit: true });
      if (!("job" in converged)) {
        throw new Error("expected declarative cron result");
      }
      expect(converged).toMatchObject({
        created: false,
        updated: false,
        job: { delivery: { mode: "announce" } },
      });
      await expect(cron.readJob(converged.job.id)).resolves.toMatchObject({
        delivery: { mode: "announce" },
      });
    } finally {
      cron.stop();
    }
  });
});
