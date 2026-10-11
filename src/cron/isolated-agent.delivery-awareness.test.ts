import "./isolated-agent.mocks.js";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { resolveDefaultSessionStorePath } from "../config/sessions.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  peekSystemEventEntries,
  peekSystemEvents,
  resetSystemEventsForTest,
} from "../infra/system-events.js";
import { normalizeSessionDeliveryState } from "../utils/delivery-context.shared.js";
import { resolveAdmittedCronCompletionStatus } from "./completion-status.js";
import { createCliDeps, mockAgentPayloads } from "./isolated-agent.delivery.test-helpers.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import { makeCfg, makeJob, withTempCronHome } from "./isolated-agent.test-harness.js";
import { setupIsolatedAgentTurnMocks } from "./isolated-agent.test-setup.js";

type AnnounceOptions = {
  texts: string[];
  cfg?: Parameters<typeof makeCfg>[2];
  entries?: Record<string, SessionEntry>;
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
    const deps = createCliDeps();
    mockAgentPayloads(options.texts.map((text) => ({ text })));
    const cfg = makeCfg(home, storePath, {
      ...options.cfg,
      ...(options.cfg?.session ? { session: { store: storePath, ...options.cfg.session } } : {}),
    });
    setRuntimeConfigSnapshot(cfg);
    for (const [sessionKey, entry] of Object.entries(options.entries ?? {})) {
      await replaceSessionEntry({ agentId: "main", storePath, sessionKey }, entry);
    }
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

describe("isolated cron delivery notifications", () => {
  afterEach(clearRuntimeConfigSnapshot);
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
        expect(deps.telegram).toHaveBeenCalledTimes(2);
        expect(peekSystemEvents("agent:main:main")).toEqual([]);
        expect(peekSystemEvents("agent:main:global")).toEqual([]);
        expect(peekSystemEventEntries("agent:other:global")).toEqual([]);
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
            delivery: normalizeSessionDeliveryState({
              context: { channel: "telegram", to: "123" },
            }),
          },
        },
      },
      (result, deps) => {
        expect(result.status).toBe("ok");
        expect(result.error).toBeUndefined();
        expect(result.delivered).toBe(false);
        expect(result.deliveryState).toMatchObject({ status: "not-delivered", delivered: false });
        expect(result.deliveryError).toContain("shared agent-main session bucket");
        expect(
          resolveAdmittedCronCompletionStatus(
            { delivery: { mode: "announce" } },
            result.status,
            result.deliveryState?.status ?? "unknown",
            result.deliverySuppressionReason,
          ),
        ).toBe("failed");
        expect(deps.telegram).not.toHaveBeenCalled();
        expect(peekSystemEvents("agent:main:main")).toStrictEqual([]);
      },
    );
  });
});
