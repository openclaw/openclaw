import fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { readSessionArchiveContentSync } from "../config/sessions/archive-compression.js";
import {
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import * as sessionArchive from "../config/sessions/session-accessor.sqlite-archive.js";
import { replaceTranscriptEvents } from "../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { waitForSessionTranscriptIndexReconcilesInStateDir } from "../config/sessions/session-transcript-reconcile.js";
import { CronService } from "../cron/service.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import { prepareUserProfileCatalog } from "../state/user-profile-list.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createDirectChatContext } from "./server-chat.agent-events.test-helpers.js";
import { dispatchGatewayRequestInProcessRaw } from "./server-in-process-dispatch.js";
import { createOperatorClient } from "./server-plugin-in-process-dispatch.test-support.js";
import { writeSessionStore } from "./test-helpers.server.js";
import {
  getGatewayConfigModule,
  setupGatewaySessionsHandlerTestHarness,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test.each(["current", "revoked"] as const)(
  "cron.remove settles delayed history deletion with %s operator authority",
  async (authority) => {
    const { dir, storePath } = await createSessionStoreDir();
    await writeSessionStore({ entries: {} });
    const { getRuntimeConfig } = await getGatewayConfigModule();
    const cronStorePath = path.join(dir, "cron", "jobs.json");
    const cron = new CronService({
      scheduler: createTestGatewayScheduler(),
      storePath: cronStorePath,
      sessionStorePath: storePath,
      defaultAgentId: "main",
      cronEnabled: false,
      log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      enqueueSystemEvent: vi.fn(),
      requestHeartbeat: vi.fn(),
      runIsolatedAgentJob: vi.fn(async () => ({ status: "ok" as const })),
    });
    const job = await cron.add({
      name: "delayed history cleanup",
      enabled: false,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "synthetic cleanup fixture" },
      delivery: { mode: "none" },
    });
    const sessionKey = `agent:main:cron:${job.id}`;
    const sessionIds = ["cleanup-history-first", "cleanup-history-second", "cleanup-current"];
    const events = sessionIds.map((id) => ({
      type: "session" as const,
      id,
      content: `preserve ${id}`,
    }));
    for (const [index, sessionId] of sessionIds.entries()) {
      await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: index + 1 });
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [events[index]!]);
    }
    await waitForSessionTranscriptIndexReconcilesInStateDir(dir);

    const executions: Promise<unknown>[] = [];
    const cfg = getRuntimeConfig();
    const context = createDirectChatContext({
      cron,
      cronStorePath,
      getRuntimeConfig: () => ({
        ...cfg,
        gateway: {
          ...cfg.gateway,
          roles: {
            default: "administrator",
            definitions: {
              administrator: {
                scopes: ["operator.admin"],
                agents: "*",
                sessions: { others: "write" },
              },
              reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
            },
          },
        },
      }),
      trackExecution: (run) => {
        const execution = trackAsyncWork(run);
        executions.push(execution);
        void execution.catch(() => {});
        return execution;
      },
    });
    context.resolveGatewayContext = () => context;
    const client = createOperatorClient({
      profileName: "cron-cleanup",
      scopes: ["operator.admin"],
    });
    using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
    const entered = createDeferred();
    const release = createDeferred();
    const materialize = sessionArchive.materializeSessionStateDeletePlans;
    let blocked = false;
    const archiveGate = vi
      .spyOn(sessionArchive, "materializeSessionStateDeletePlans")
      .mockImplementation(async (...args) => {
        const result = await materialize(...args);
        if (!blocked) {
          blocked = true;
          entered.resolve();
          await release.promise;
        }
        return result;
      });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const removal = dispatchGatewayRequestInProcessRaw(
      "cron.remove",
      { id: job.id },
      { client, context },
    );
    const observed = removal.then(
      (response) => ({ response }),
      (error: unknown) => ({ error: error instanceof Error ? error.stack : String(error) }),
    );
    try {
      await Promise.race([
        entered.promise,
        observed.then((outcome) => {
          throw new Error(
            `cron.remove finished before archive materialization: ${JSON.stringify(outcome)}`,
          );
        }),
      ]);
      expect(await cron.readJob(job.id)).toBeUndefined();
      expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(sessionIds[2]);
      // Advance only timers: physical workers and transcript bytes remain real.
      await vi.advanceTimersByTimeAsync(10_001);
      vi.useRealTimers();
      if (authority === "revoked") {
        await setCanonicalUserProfileRole(client.authenticatedUserProfile!.profileId, "reader");
      }
      release.resolve();
      const outcome = await observed;
      const handlerSettlements = await Promise.allSettled(executions);
      const archives = (await fs.readdir(dir)).filter((name) => name.includes(".deleted."));
      const archived = archives.map((name) => readSessionArchiveContentSync(path.join(dir, name)));
      const result = {
        outcome,
        base: loadSessionEntry({ sessionKey, storePath }),
        archivedGenerations: events.map((event) =>
          archived.some((content) => content.includes(JSON.stringify(event))),
        ),
        handlerErrors: handlerSettlements.flatMap((settlement) =>
          settlement.status === "fulfilled" ? [] : [String(settlement.reason)],
        ),
      };
      if (authority === "revoked") {
        expect(result).toMatchObject({
          outcome: { error: expect.stringMatching(/operator.*authority|role.*changed/) },
          base: { sessionId: sessionIds[2] },
          archivedGenerations: [false, false, false],
        });
        for (const [index, sessionId] of sessionIds.entries()) {
          expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toEqual([
            events[index],
          ]);
        }
      } else {
        expect(result).toMatchObject({
          outcome: { response: { ok: true, payload: { removed: true } } },
          base: undefined,
          archivedGenerations: [true, true, true],
          handlerErrors: [],
        });
        for (const sessionId of sessionIds) {
          expect(await loadTranscriptEvents({ sessionKey, sessionId, storePath })).toEqual([]);
        }
      }
    } finally {
      vi.useRealTimers();
      release.resolve();
      await observed;
      await Promise.allSettled(executions);
      archiveGate.mockRestore();
      cron.stop();
    }
  },
);
