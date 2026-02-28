import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSubagentAnnounceFlow } from "../agents/subagent-announce.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

describe("cron delivery responsePrefix", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("applies global responsePrefix to announce delivery", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "Hello from cron job" }]);
      const cfg = makeCfg(home, storePath, {
        messages: { responsePrefix: "[CronBot]" },
        channels: { telegram: { botToken: "t-1" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "test" }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "test",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { roundOneReply?: string }
        | undefined;
      expect(announceArgs?.roundOneReply).toBe("[CronBot] Hello from cron job");
    });
  });

  it("resolves 'auto' responsePrefix to identity name", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "Hello from cron job" }]);
      const cfg = makeCfg(home, storePath, {
        agents: {
          list: [{ id: "agent:main", identity: { name: "Thames" } }],
        },
        messages: { responsePrefix: "auto" },
        channels: { telegram: { botToken: "t-1" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "test" }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "test",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { roundOneReply?: string }
        | undefined;
      expect(announceArgs?.roundOneReply).toBe("[Thames] Hello from cron job");
    });
  });

  it("does not duplicate prefix if already present in response", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "[CronBot] Already has prefix" }]);
      const cfg = makeCfg(home, storePath, {
        messages: { responsePrefix: "[CronBot]" },
        channels: { telegram: { botToken: "t-1" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "test" }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "test",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { roundOneReply?: string }
        | undefined;
      expect(announceArgs?.roundOneReply).toBe("[CronBot] Already has prefix");
    });
  });

  it("works without responsePrefix configured", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "Hello without prefix" }]);
      const cfg = makeCfg(home, storePath, {
        channels: { telegram: { botToken: "t-1" } },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "test" }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "test",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { roundOneReply?: string }
        | undefined;
      expect(announceArgs?.roundOneReply).toBe("Hello without prefix");
    });
  });

  it("applies channel-level responsePrefix", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = createCliDeps();
      mockAgentPayloads([{ text: "Hello from cron job" }]);
      const cfg = makeCfg(home, storePath, {
        messages: { responsePrefix: "[Global]" },
        channels: {
          telegram: { botToken: "t-1", responsePrefix: "[TelegramBot]" },
        },
      });

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({ kind: "agentTurn", message: "test" }),
          delivery: { mode: "announce", channel: "telegram", to: "123" },
        },
        message: "test",
        sessionKey: "cron:job-1",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      expect(res.delivered).toBe(true);
      expect(runSubagentAnnounceFlow).toHaveBeenCalledTimes(1);
      const announceArgs = vi.mocked(runSubagentAnnounceFlow).mock.calls[0]?.[0] as
        | { roundOneReply?: string }
        | undefined;
      expect(announceArgs?.roundOneReply).toBe("[TelegramBot] Hello from cron job");
    });
  });
});
