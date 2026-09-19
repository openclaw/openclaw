import { describe, expect, it, vi } from "vitest";
import { CronService } from "./service.js";
import { setupCronServiceSuite } from "./service.test-harness.js";
import { loadCronStore } from "./store.js";
import type { CronJobCreate } from "./types.js";

const { logger, makeStorePath } = setupCronServiceSuite({
  prefix: "cron-scheduled-policy-preservation-",
});
const owner = {
  agentId: "ops",
  sessionKey: "agent:ops:discord:group:ops",
  accountId: "work",
};
const accountPolicy = {
  version: 1,
  mode: "account",
  ownerSessionKey: owner.sessionKey,
  ownerAccountId: owner.accountId,
} as const;

describe("scheduled policy preservation across payload conversions", () => {
  it.each([
    { mutation: "update", mode: "account" },
    { mutation: "update", mode: "trusted" },
    { mutation: "declaration", mode: "account" },
    { mutation: "declaration", mode: "trusted" },
  ] as const)(
    "preserves $mode policy across operator payload conversions through $mutation",
    async ({ mutation, mode }) => {
      const { storePath } = await makeStorePath();
      const cron = new CronService({
        storePath,
        cronEnabled: false,
        log: logger,
        enqueueSystemEvent: vi.fn(),
        requestHeartbeat: vi.fn(),
        runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
      });
      const input: CronJobCreate = {
        name: "scheduled report",
        declarationKey: "agent:ops:scheduled-report",
        owner,
        sessionKey: owner.sessionKey,
        enabled: true,
        schedule: { kind: "every", everyMs: 60_000 },
        sessionTarget: "isolated",
        wakeMode: "next-heartbeat",
        payload: { kind: "agentTurn", message: "report", toolsAllow: ["message"] },
        delivery: { mode: "none" },
      };
      try {
        const created = await cron.add(
          input,
          mode === "account" ? { scheduledToolPolicy: accountPolicy } : undefined,
        );
        if (mutation === "update") {
          await cron.update(created.id, {
            payload: { kind: "systemEvent", text: "report" },
            sessionTarget: "main",
          });
        } else {
          await cron.add({ ...input, payload: { kind: "command", argv: ["true"] } });
        }
        const dormant = (await loadCronStore(storePath)).jobs[0];
        expect(dormant?.scheduledToolPolicy).toEqual(
          mode === "account" ? accountPolicy : undefined,
        );

        if (mutation === "update") {
          await cron.update(created.id, {
            payload: { kind: "agentTurn", message: "report" },
            sessionTarget: "isolated",
          });
        } else {
          await cron.add(input);
        }
        const restored = (await loadCronStore(storePath)).jobs[0];
        expect(restored?.scheduledToolPolicy).toEqual(
          mode === "account" ? accountPolicy : { version: 1, mode: "trusted" },
        );
        expect(restored?.owner).toMatchObject(owner);
        expect(restored?.payload.toolsAllow).toEqual(["message"]);
      } finally {
        cron.stop();
      }
    },
  );
});
