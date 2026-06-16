// Delivery lease lifecycle integration tests verify that in-memory route leases
// are registered, used for delivery origin resolution, and retired after final
// delivery settles through the full runCronIsolatedAgentTurn flow.
import "./isolated-agent.mocks.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveAnnounceOrigin } from "../agents/subagent-announce-origin.js";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import {
  getDeliveryLeaseCountForTests,
  registerDeliveryLease,
  resetDeliveryLeasesForTests,
} from "../infra/delivery-lease-store.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import {
  createCliDeps,
  expectDirectTelegramDelivery,
  mockAgentPayloads,
  runTelegramAnnounceTurn,
} from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("delivery lease lifecycle in isolated cron runs", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks({ fast: true });
  });

  afterEach(() => {
    resetDeliveryLeasesForTests();
  });

  it("retires delivery lease after telegram announce delivery settles", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      makeCfg(home, storePath, {
        channels: { telegram: { botToken: "t-1" } },
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "cron task completed" }]);

      expect(getDeliveryLeaseCountForTests()).toBe(0);

      const res = await runTelegramAnnounceTurn({
        home,
        storePath,
        deps,
        delivery: { mode: "announce", channel: "telegram", to: "123" },
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).not.toHaveBeenCalled();
      expectDirectTelegramDelivery(deps, { chatId: "123", text: "cron task completed" });

      // Lease must be retired after delivery settles. A lingering lease
      // would prove the lifecycle hook in delivery-dispatch fired incorrectly.
      expect(getDeliveryLeaseCountForTests()).toBe(0);
    });
  });

  it("retires delivery lease after explicit cron announce turn", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const cfg = makeCfg(home, storePath, {
        channels: { telegram: { botToken: "t-1" } },
      });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "hello from cron" }]);

      expect(getDeliveryLeaseCountForTests()).toBe(0);

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "do it" }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "do it",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);

      expect(getDeliveryLeaseCountForTests()).toBe(0);
    });
  });
});

describe("resolveAnnounceOrigin lease fallback", () => {
  beforeEach(() => {
    resetDeliveryLeasesForTests();
  });

  afterEach(() => {
    resetDeliveryLeasesForTests();
  });

  it("resolves delivery origin from lease when session entry has no deliveryContext", () => {
    const sessionKey = "cron:test:agent:main:run:abc123";
    const ctx: DeliveryContext = {
      channel: "webchat",
      to: "controller",
      accountId: "default",
      threadId: "thread-42",
    };
    registerDeliveryLease(sessionKey, ctx);

    const origin = resolveAnnounceOrigin({}, undefined, sessionKey);
    expect(origin).toBeDefined();
    expect(origin?.channel).toBe("webchat");
    expect(origin?.to).toBe("controller");
    expect(origin?.accountId).toBe("default");
    expect(origin?.threadId).toBe("thread-42");
  });

  it("returns undefined for empty entry without sessionKey fallback", () => {
    const origin = resolveAnnounceOrigin({}, undefined);
    expect(origin).toBeUndefined();
  });

  it("returns undefined for unknown sessionKey", () => {
    const origin = resolveAnnounceOrigin({}, undefined, "nonexistent-key");
    expect(origin).toBeUndefined();
  });

  it("prefers session entry deliveryContext over lease fallback", () => {
    const sessionKey = "cron:test:run:xyz";
    registerDeliveryLease(sessionKey, {
      channel: "webchat",
      to: "controller",
    });

    const origin = resolveAnnounceOrigin(
      { deliveryContext: { channel: "telegram", to: "123" } },
      undefined,
      sessionKey,
    );

    expect(origin?.channel).toBe("telegram");
    expect(origin?.to).toBe("123");
  });
});
