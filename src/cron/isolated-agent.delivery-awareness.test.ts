import fs from "node:fs/promises";
import path from "node:path";
import "./isolated-agent.mocks.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../config/sessions.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

type AnnounceOptions = {
  texts: string[];
  cfg?: Parameters<typeof makeCfg>[2];
  entries?: Record<string, Record<string, unknown>>;
  delivery?: { mode: "announce"; channel: "last" | "telegram"; to?: string };
};
async function withAnnounce(
  options: AnnounceOptions,
  check: (
    result: Awaited<ReturnType<typeof runCronIsolatedAgentTurn>>,
    deps: ReturnType<typeof createCliDeps>,
  ) => void = () => {},
) {
  await withTempCronHome(async (home) => {
    const storePath = resolveDefaultSessionStorePath("main");
    await fs.mkdir(path.dirname(storePath), { recursive: true });
    await fs.writeFile(storePath, JSON.stringify(options.entries ?? {}), "utf-8");
    const deps = createCliDeps();
    mockAgentPayloads(options.texts.map((text) => ({ text })));
    const cfg = makeCfg(home, storePath, {
      ...options.cfg,
      ...(options.cfg?.session ? { session: { store: storePath, ...options.cfg.session } } : {}),
    });
    setRuntimeConfigSnapshot(cfg);
    const result = await runCronIsolatedAgentTurn({
      deliveryAttemptFence: null,
      cfg,
      deps,
      job: {
        ...makeJob({ kind: "agentTurn", message: "do it" }),
        delivery: options.delivery ?? { mode: "announce", channel: "telegram", to: "123" },
      },
      message: "do it",
      sessionKey: "cron:job-1",
      lane: "cron",
    });
    check(result, deps);
  });
}

describe("isolated cron delivery awareness", () => {
  beforeAll(async () => {
    setupIsolatedAgentTurnMocks();
    resetSystemEventsForTest();
    await withAnnounce({ texts: ["warm runtime"] });
    clearRuntimeConfigSnapshot();
  });
  beforeEach(() => {
    setupIsolatedAgentTurnMocks();
    resetSystemEventsForTest();
  });
  afterEach(clearRuntimeConfigSnapshot);

  it("queues delivered text for the next main-session turn", async () => {
    await withAnnounce({ texts: ["hello from cron"] }, (result) => {
      expect(result.status).toBe("ok");
      expect(result.delivered).toBe(true);
      expect(peekSystemEvents("agent:main:main")).toEqual(["hello from cron"]);
    });
  });

  it("adds the exact run-session inspection link only to the final visible payload", async () => {
    await withAnnounce(
      {
        texts: ["first cron update", "final cron summary"],
        cfg: {
          gateway: { publicOrigin: "https://control.example", controlUi: { basePath: "/console" } },
        },
      },
      (result, deps) => {
        expect(result.status).toBe("ok");
        expect(result.delivered).toBe(true);
        expect(result.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
        expect(deps.telegram).toHaveBeenNthCalledWith(
          1,
          "123",
          "first cron update",
          expect.any(Object),
        );
        expect(deps.telegram).toHaveBeenNthCalledWith(
          2,
          "123",
          `final cron summary\nInspect: https://control.example/console/chat/main/${result.sessionKey?.replace(/^agent:main:/, "").replaceAll(":", "/")}`,
          expect.any(Object),
        );
      },
    );
  });

  it("does not turn a silent reply into an inspection-link announcement", async () => {
    await withAnnounce(
      { texts: ["NO_REPLY"], cfg: { gateway: { publicOrigin: "https://control.example" } } },
      (result, deps) => {
        expect(result.status).toBe("ok");
        expect(result.delivered).toBeFalsy();
        expect(deps.telegram).not.toHaveBeenCalled();
      },
    );
  });

  it("scopes the global main queue to the delivering agent", async () => {
    await withAnnounce(
      { texts: ["global cron digest"], cfg: { session: { scope: "global", mainKey: "main" } } },
      (result) => {
        expect(result.status).toBe("ok");
        expect(result.delivered).toBe(true);
        expect(peekSystemEvents("agent:main:global")).toEqual(["global cron digest"]);
        expect(peekSystemEventEntries("agent:main:global")).toHaveLength(1);
        expect(peekSystemEventEntries("agent:other:global")).toEqual([]);
      },
    );
  });

  it("refuses keyless delivery inherited from another conversation's shared main bucket", async () => {
    // #91613: main.lastTo belongs to whichever conversation last wrote the shared bucket.
    await withAnnounce(
      {
        texts: ["implicit cron digest"],
        delivery: { mode: "announce", channel: "last" },
        entries: {
          "agent:main:main": {
            sessionId: "main-session",
            updatedAt: Date.now(),
            lastProvider: "telegram",
            lastChannel: "telegram",
            lastTo: "123",
          },
        },
      },
      (result) => {
        expect(result.status).toBe("error");
        expect(result.delivered).toBeFalsy();
        expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
      },
    );
  });
});
