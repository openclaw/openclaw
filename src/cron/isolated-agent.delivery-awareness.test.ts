import fs from "node:fs/promises";
import path from "node:path";
import "./isolated-agent.mocks.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliDeps } from "../cli/deps.js";
import type { OpenClawConfig } from "../config/config.js";
import { callGateway } from "../gateway/call.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";
import type { CronSessionTarget } from "./types.js";

async function runAnnounceTurn(params: {
  home: string;
  storePath: string;
  jobSessionKey?: string;
  runtimeSessionKey?: string;
  sessionTarget?: CronSessionTarget;
  deliveryContract?: "cron-owned" | "shared";
  deps?: CliDeps;
  deliveryChannel?: "telegram" | "last";
  deliveryTo?: string | null;
  cfgOverrides?: Partial<OpenClawConfig>;
}) {
  return await runCronIsolatedAgentTurn({
    cfg: makeCfg(params.home, params.storePath, params.cfgOverrides),
    deps: params.deps ?? createCliDeps(),
    job: {
      ...makeJob({ kind: "agentTurn", message: "do it" }),
      ...(params.jobSessionKey ? { sessionKey: params.jobSessionKey } : {}),
      ...(params.sessionTarget ? { sessionTarget: params.sessionTarget } : {}),
      delivery: {
        mode: "announce",
        channel: params.deliveryChannel ?? "telegram",
        ...(params.deliveryTo === null ? {} : { to: params.deliveryTo ?? "123" }),
      },
    },
    message: "do it",
    sessionKey: params.runtimeSessionKey ?? params.jobSessionKey ?? "cron:job-1",
    lane: "cron",
    deliveryContract: params.deliveryContract,
  });
}

async function writeAgentScopedSessionStoreEntries(params: {
  home: string;
  byAgent: Record<string, Record<string, Record<string, unknown>>>;
}): Promise<string> {
  const storeTemplate = path.join(
    params.home,
    ".openclaw",
    "agents",
    "{agentId}",
    "sessions",
    "sessions.json",
  );
  for (const [agentId, entries] of Object.entries(params.byAgent)) {
    const storePath = storeTemplate.replace("{agentId}", agentId);
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(entries, null, 2), "utf-8");
  }
  return storeTemplate;
}

describe("runCronIsolatedAgentTurn cron delivery awareness", () => {
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
  });

  it("injects delivered cron text back into the main session transcript", async () => {
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;
    try {
      await withTempCronHome(async (home) => {
        const storePath = await writeSessionStoreEntries(home, {
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastProvider: "telegram",
            lastTo: "123",
            lastChannel: "telegram",
          },
        });
        mockAgentPayloads([{ text: "hello from cron" }]);

        const res = await runAnnounceTurn({ home, storePath });

        expect(res.status).toBe("ok");
        expect(res.delivered).toBe(true);
        expect(vi.mocked(callGateway).mock.calls).toContainEqual([
          expect.objectContaining({
            method: "chat.inject",
            params: expect.objectContaining({
              sessionKey: "agent:main:main",
              message: "hello from cron",
              label: "Cron delivery",
              idempotencyKey: expect.stringContaining("cron-awareness:v2:"),
            }),
          }),
        ]);
      });
    } finally {
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });

  it("uses the routed thread session for implicit delivery and awareness when the job is bound to one", async () => {
    await withTempCronHome(async (home) => {
      const deps = createCliDeps();
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "-100111",
          lastChannel: "telegram",
        },
        "agent:main:main:thread:42": {
          sessionId: "thread-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "-100222",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "thread digest" }]);

      await runAnnounceTurn({
        home,
        storePath,
        deps,
        jobSessionKey: "agent:main:main:thread:42",
        deliveryChannel: "last",
        deliveryTo: null,
      });

      expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
        "-100222",
        "thread digest",
        expect.any(Object),
      );

      expect(vi.mocked(callGateway).mock.calls).toContainEqual([
        expect.objectContaining({
          method: "chat.inject",
          params: expect.objectContaining({
            sessionKey: "agent:main:main:thread:42",
            message: "thread digest",
          }),
        }),
      ]);
    });
  });

  it("normalizes the runtime session key when the job does not carry one", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "123",
          lastChannel: "telegram",
        },
        "agent:main:slack:channel:c123": {
          sessionId: "slack-channel-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "123",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "hook delivery digest" }]);

      await runAnnounceTurn({
        home,
        storePath,
        runtimeSessionKey: "slack:channel:c123",
        deliveryContract: "shared",
      });

      expect(vi.mocked(callGateway).mock.calls).toContainEqual([
        expect.objectContaining({
          method: "chat.inject",
          params: expect.objectContaining({
            sessionKey: "agent:main:slack:channel:c123",
            message: "hook delivery digest",
          }),
        }),
      ]);
    });
  });

  it("routes main-session aliases to the configured canonical main key", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:work": {
          sessionId: "work-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "123",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "custom main alias delivery" }]);

      await runAnnounceTurn({
        home,
        storePath,
        runtimeSessionKey: "main",
        sessionTarget: "session:main",
        deliveryContract: "shared",
        deliveryChannel: "last",
        deliveryTo: null,
        cfgOverrides: {
          session: { store: storePath, mainKey: "work" },
        },
      });

      expect(vi.mocked(callGateway).mock.calls).toContainEqual([
        expect.objectContaining({
          method: "chat.inject",
          params: expect.objectContaining({
            sessionKey: "agent:main:work",
            message: "custom main alias delivery",
          }),
        }),
      ]);

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
      expect(store["agent:main:main"]).toBeUndefined();
    });
  });

  it("uses the global transcript when session scope is global", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        global: {
          sessionId: "global-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "123",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "global cron delivery" }]);

      await runAnnounceTurn({
        home,
        storePath,
        runtimeSessionKey: "main",
        sessionTarget: "session:main",
        deliveryContract: "shared",
        deliveryChannel: "last",
        deliveryTo: null,
        cfgOverrides: {
          session: { store: storePath, scope: "global" },
        },
      });

      expect(vi.mocked(callGateway).mock.calls).toContainEqual([
        expect.objectContaining({
          method: "chat.inject",
          params: expect.objectContaining({
            sessionKey: "global",
            message: "global cron delivery",
          }),
        }),
      ]);

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<string, unknown>;
      expect(store["agent:main:main"]).toBeUndefined();
    });
  });

  it("creates the main awareness session when none exists yet", async () => {
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;
    try {
      await withTempCronHome(async (home) => {
        const storePath = await writeSessionStoreEntries(home, {});
        mockAgentPayloads([{ text: "first cron memory" }]);

        const res = await runAnnounceTurn({ home, storePath });

        expect(res.status).toBe("ok");
        expect(res.delivered).toBe(true);
        expect(vi.mocked(callGateway).mock.calls).toContainEqual([
          expect.objectContaining({
            method: "chat.inject",
            params: expect.objectContaining({
              sessionKey: "agent:main:main",
              message: "first cron memory",
            }),
          }),
        ]);

        const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
          string,
          { sessionId?: string }
        >;
        expect(typeof store["agent:main:main"]?.sessionId).toBe("string");
      });
    } finally {
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });

  it("creates a fresh bound awareness session instead of reusing the main transcript", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "-100111",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "thread awareness" }]);

      await runAnnounceTurn({
        home,
        storePath,
        runtimeSessionKey: "agent:main:main:thread:42",
        sessionTarget: "session:agent:main:main:thread:42",
        deliveryChannel: "last",
        deliveryTo: null,
      });

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        {
          sessionId?: string;
          lastChannel?: string;
          lastTo?: string;
        }
      >;
      const threadEntry = store["agent:main:main:thread:42"];

      expect(typeof threadEntry?.sessionId).toBe("string");
      expect(threadEntry?.sessionId).not.toBe("main-session");
      expect(threadEntry?.lastChannel).toBe("telegram");
      expect(threadEntry?.lastTo).toBe("-100111");
    });
  });

  it("backfills delivery context for bound awareness sessions that already have a transcript", async () => {
    await withTempCronHome(async (home) => {
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "-100111",
          lastChannel: "telegram",
        },
        "agent:main:main:thread:42": {
          sessionId: "thread-session",
          updatedAt: Date.now(),
        },
      });
      mockAgentPayloads([{ text: "route-less thread awareness" }]);

      await runAnnounceTurn({
        home,
        storePath,
        runtimeSessionKey: "agent:main:main:thread:42",
        sessionTarget: "session:agent:main:main:thread:42",
        deliveryChannel: "last",
        deliveryTo: null,
      });

      const store = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
        string,
        {
          sessionId?: string;
          lastChannel?: string;
          lastTo?: string;
        }
      >;
      const threadEntry = store["agent:main:main:thread:42"];

      expect(threadEntry?.sessionId).toBe("thread-session");
      expect(threadEntry?.lastChannel).toBe("telegram");
      expect(threadEntry?.lastTo).toBe("-100111");
    });
  });

  it("does not reuse hook scratch routes for shared implicit delivery", async () => {
    await withTempCronHome(async (home) => {
      const deps = createCliDeps();
      const storePath = await writeSessionStoreEntries(home, {
        "agent:main:main": {
          sessionId: "main-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "-100111",
          lastChannel: "telegram",
        },
        "agent:main:hook:webhook:42": {
          sessionId: "hook-session",
          updatedAt: Date.now(),
          lastProvider: "telegram",
          lastTo: "-100999",
          lastChannel: "telegram",
        },
      });
      mockAgentPayloads([{ text: "hook implicit delivery" }]);

      await runAnnounceTurn({
        home,
        storePath,
        deps,
        runtimeSessionKey: "hook:webhook:42",
        deliveryContract: "shared",
        deliveryChannel: "last",
        deliveryTo: null,
      });

      expect(deps.sendMessageTelegram).toHaveBeenCalledWith(
        "-100111",
        "hook implicit delivery",
        expect.any(Object),
      );
      expect(vi.mocked(callGateway).mock.calls).toContainEqual([
        expect.objectContaining({
          method: "chat.inject",
          params: expect.objectContaining({
            sessionKey: "agent:main:main",
            message: "hook implicit delivery",
          }),
        }),
      ]);
    });
  });

  it("writes cross-agent awareness session entries into the target agent store", async () => {
    const previousFast = process.env.OPENCLAW_TEST_FAST;
    delete process.env.OPENCLAW_TEST_FAST;
    try {
      await withTempCronHome(async (home) => {
        const storeTemplate = await writeAgentScopedSessionStoreEntries({
          home,
          byAgent: {
            main: {
              "agent:main:main": {
                sessionId: "main-session",
                updatedAt: Date.now(),
                lastProvider: "telegram",
                lastTo: "123",
                lastChannel: "telegram",
              },
            },
            ops: {},
          },
        });
        mockAgentPayloads([{ text: "cross agent awareness" }]);

        await runAnnounceTurn({
          home,
          storePath: storeTemplate,
          runtimeSessionKey: "agent:ops:main",
          sessionTarget: "session:agent:ops:main",
          cfgOverrides: {
            session: { store: storeTemplate, mainKey: "main" },
          },
        });

        expect(vi.mocked(callGateway).mock.calls).toContainEqual([
          expect.objectContaining({
            method: "chat.inject",
            params: expect.objectContaining({
              sessionKey: "agent:ops:main",
              message: "cross agent awareness",
            }),
          }),
        ]);

        const opsStore = JSON.parse(
          await fs.readFile(storeTemplate.replace("{agentId}", "ops"), "utf-8"),
        ) as Record<string, { sessionId?: string }>;

        expect(typeof opsStore["agent:ops:main"]?.sessionId).toBe("string");
      });
    } finally {
      if (previousFast === undefined) {
        delete process.env.OPENCLAW_TEST_FAST;
      } else {
        process.env.OPENCLAW_TEST_FAST = previousFast;
      }
    }
  });

  it("uses a unique awareness idempotency key for repeated runs in a reused bound session", async () => {
    vi.useFakeTimers();
    try {
      await withTempCronHome(async (home) => {
        const firstRunAt = new Date("2026-03-22T10:00:00.000Z");
        vi.setSystemTime(firstRunAt);
        const storePath = await writeSessionStoreEntries(home, {
          "agent:main:slack:channel:c123": {
            sessionId: "reused-session",
            updatedAt: firstRunAt.getTime(),
            lastProvider: "telegram",
            lastTo: "123",
            lastChannel: "telegram",
          },
        });

        mockAgentPayloads([{ text: "first bound delivery" }]);
        await runAnnounceTurn({
          home,
          storePath,
          runtimeSessionKey: "agent:main:slack:channel:c123",
          sessionTarget: "session:agent:main:slack:channel:c123",
        });

        const firstInjectCall = vi
          .mocked(callGateway)
          .mock.calls.find(([call]) => call.method === "chat.inject");
        const firstInjectParams = firstInjectCall?.[0].params as
          | { idempotencyKey?: string }
          | undefined;
        const firstIdempotencyKey = firstInjectParams?.idempotencyKey;

        vi.mocked(callGateway).mockClear();
        vi.setSystemTime(new Date(firstRunAt.getTime() + 60_000));

        mockAgentPayloads([{ text: "second bound delivery" }]);
        await runAnnounceTurn({
          home,
          storePath,
          runtimeSessionKey: "agent:main:slack:channel:c123",
          sessionTarget: "session:agent:main:slack:channel:c123",
        });

        const secondInjectCall = vi
          .mocked(callGateway)
          .mock.calls.find(([call]) => call.method === "chat.inject");
        const secondInjectParams = secondInjectCall?.[0].params as
          | { idempotencyKey?: string }
          | undefined;
        const secondIdempotencyKey = secondInjectParams?.idempotencyKey;

        expect(typeof firstIdempotencyKey).toBe("string");
        expect(typeof secondIdempotencyKey).toBe("string");
        expect(secondIdempotencyKey).not.toBe(firstIdempotencyKey);
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
