import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type HeartbeatAfterHookContext,
  type HeartbeatBeforeHookContext,
  type InternalHookEvent,
} from "../hooks/internal-hooks.js";
import { clearHeartbeatEventHistory } from "./heartbeat-events.js";
import { runHeartbeatOnce } from "./heartbeat-runner.js";
import { withTempHeartbeatSandbox, seedMainSessionStore } from "./heartbeat-runner.test-utils.js";

// Avoid pulling optional runtime deps during isolated runs.
vi.mock("jiti", () => ({ createJiti: () => () => ({}) }));

describe("heartbeat hooks integration", () => {
  beforeEach(() => {
    clearInternalHooks();
    clearHeartbeatEventHistory();
  });

  afterEach(() => {
    clearInternalHooks();
    clearHeartbeatEventHistory();
    vi.restoreAllMocks();
  });

  it("fires heartbeat:before with prompt and agentId before LLM call", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = {
        agents: { defaults: { heartbeat: { every: "30m", target: "none" } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
      });

      replySpy.mockResolvedValue({
        payloads: [{ text: "All clear" }],
      });

      const beforeEvents: InternalHookEvent[] = [];
      registerInternalHook("heartbeat:before", (event) => {
        beforeEvents.push(event);
      });

      await runHeartbeatOnce({ cfg });

      expect(beforeEvents).toHaveLength(1);
      const ctx = beforeEvents[0].context as HeartbeatBeforeHookContext;
      expect(ctx.agentId).toBe("main");
      expect(typeof ctx.prompt).toBe("string");
      expect(ctx.prompt.length).toBeGreaterThan(0);
      expect(typeof ctx.sessionKey).toBe("string");
    });
  });

  it("fires heartbeat:after with status on each outcome", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = {
        agents: { defaults: { heartbeat: { every: "30m", target: "none" } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
      });

      // Return empty payload → ok-empty path
      replySpy.mockResolvedValue({ payloads: [{}] });

      const afterEvents: InternalHookEvent[] = [];
      registerInternalHook("heartbeat:after", (event) => {
        afterEvents.push(event);
      });

      await runHeartbeatOnce({ cfg });

      expect(afterEvents).toHaveLength(1);
      const ctx = afterEvents[0].context as HeartbeatAfterHookContext;
      expect(ctx.agentId).toBe("main");
      expect(typeof ctx.durationMs).toBe("number");
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
      // status could be ok-empty or skipped depending on delivery target
      expect(["ok-empty", "ok-token", "skipped", "sent"]).toContain(ctx.status);
    });
  });

  it("heartbeat:before fires before heartbeat:after", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = {
        agents: { defaults: { heartbeat: { every: "30m", target: "none" } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
      });

      replySpy.mockResolvedValue({ payloads: [{}] });

      const order: string[] = [];
      registerInternalHook("heartbeat:before", () => {
        order.push("before");
      });
      registerInternalHook("heartbeat:after", () => {
        order.push("after");
      });

      await runHeartbeatOnce({ cfg });

      expect(order).toEqual(["before", "after"]);
    });
  });

  it("hook errors do not prevent heartbeat completion", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = {
        agents: { defaults: { heartbeat: { every: "30m", target: "none" } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
      });

      replySpy.mockResolvedValue({ payloads: [{}] });

      registerInternalHook("heartbeat:before", () => {
        throw new Error("before hook exploded");
      });
      registerInternalHook("heartbeat:after", () => {
        throw new Error("after hook exploded");
      });

      // Should complete without throwing despite hook errors
      const result = await runHeartbeatOnce({ cfg });
      expect(result.status).not.toBe("failed");
    });
  });

  it("fires heartbeat:after with status='failed' on error", async () => {
    await withTempHeartbeatSandbox(async ({ storePath, replySpy }) => {
      const cfg = {
        agents: { defaults: { heartbeat: { every: "30m", target: "none" } } },
        session: { store: storePath },
      };
      await seedMainSessionStore(storePath, cfg, {
        lastChannel: "telegram",
        lastProvider: "telegram",
        lastTo: "123",
      });

      replySpy.mockRejectedValue(new Error("LLM call failed"));

      const afterEvents: InternalHookEvent[] = [];
      registerInternalHook("heartbeat:after", (event) => {
        afterEvents.push(event);
      });

      const result = await runHeartbeatOnce({ cfg });
      expect(result.status).toBe("failed");

      expect(afterEvents).toHaveLength(1);
      const ctx = afterEvents[0].context as HeartbeatAfterHookContext;
      expect(ctx.status).toBe("failed");
      expect(ctx.durationMs).toBeGreaterThanOrEqual(0);
    });
  });
});
