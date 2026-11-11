import { afterEach, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { notifyPreparedModelRuntimePublication } from "../agents/prepared-model-runtime.publication-events.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { createOwnedTestInstance } from "../plugins/plugin-instance.test-support.js";
import { PREPARED_THINKING_POLICY } from "../plugins/provider-thinking-catalog.js";
import { sessionChanges } from "../sessions/session-row-changes.js";
import { createDeferredCore } from "../shared/deferred.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { respondUnavailableOnThrow } from "./server-methods/response.js";
import { sessionProcessHandlers } from "./server-methods/session-processes.js";
import { sessionByKeyReadHandlers } from "./server-methods/sessions-read-by-key.js";
import { requestContext } from "./server-methods/sessions-read-cache.test-support.js";
import { bindSessionRowProjection } from "./session-row-projection-access.js";
import {
  createTestProjection,
  holdForeground,
  seedRow,
  watchRowFacts,
  waitForRead,
} from "./session-row-projection.read-fixture.test-support.js";
import { requestSessionRow } from "./session-row-projection.test-support.js";

afterEach(() => vi.restoreAllMocks());

it.for([
  ["sessions.describe", false],
  ["sessions.processes.list", false],
  ["sessions.describe", true],
] as const)(
  "%s rebinds a catalog policy retired during row preparation (replacement retired=%s)",
  async ([method, retired], { signal }) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const cfg = { agents: { entries: { main: {} } } };
      setRuntimeConfigSnapshot(cfg);
      const key = "agent:main:reload";
      const old = createOwnedTestInstance("fixture-provider");
      const current = createOwnedTestInstance("fixture-provider");
      const attempted = createDeferredCore();
      const catalog = (instance: typeof old) => [
        {
          id: "fixture",
          name: "Fixture",
          provider: "fixture-provider",
          contextTokens: 8192,
          reasoning: true,
          [PREPARED_THINKING_POLICY]: {
            resolve: vi.fn(() => {
              try {
                return instance.run(() => ({
                  levels: [{ id: "off" as const }, { id: "high" as const }],
                  defaultLevel: instance === old ? ("off" as const) : ("high" as const),
                }));
              } finally {
                attempted.resolve();
              }
            }),
          },
        },
      ];
      let published = catalog(old);
      using _ = holdForeground();
      using projection = await createTestProjection({
        cfg,
        getModelCatalog: async () => published,
      });
      const context = bindSessionRowProjection(requestContext(cfg), () => projection);
      const entered = createDeferredCore();
      const resume = createDeferredCore();
      watchRowFacts((owner) => async (...args) => {
        entered.resolve();
        await resume.promise;
        return owner.readRowFacts(...args);
      });
      seedRow(key, {
        sessionId: "reload",
        updatedAt: 1,
        providerOverride: "fixture-provider",
        modelOverride: "fixture",
      });
      sessionChanges.emit({ sessionKey: key, agentId: "main", factsInvalidated: true });
      const respond = vi.fn();
      const handler =
        method === "sessions.describe"
          ? sessionByKeyReadHandlers[method]!
          : sessionProcessHandlers[method]!;
      const pending = respondUnavailableOnThrow(respond, async () => {
        await requestSessionRow(handler, context, method, { key }, respond, null);
      });
      void pending.catch(() => {});
      const replacement = createDeferredCore();
      let release: (() => void) | undefined;
      try {
        await waitForRead(entered.promise, pending, signal, "RPC finished before row read");
        release = old.reserveReplacement();
        notifyPreparedModelRuntimePublication({
          phase: "invalidated",
          replacement: replacement.promise,
        });
        old.quiesce();
        if (retired) {
          current.quiesce();
        }
        published = catalog(current);
        resume.resolve();
        // The read has to encounter the retired callback before renewal finishes.
        await waitForRead(
          attempted.promise,
          pending,
          signal,
          "RPC finished before retired policy read",
        );
        release?.();
        replacement.resolve();
        await withinTest(pending, signal);
        expect(respond).toHaveBeenCalledOnce();
        if (retired) {
          expect(respond.mock.calls[0]).toMatchObject([
            false,
            undefined,
            {
              code: "UNAVAILABLE",
              message: expect.stringContaining("Session model catalog is unavailable"),
            },
          ]);
          expect(JSON.stringify(respond.mock.calls)).not.toContain("current tools");
        } else {
          expect(respond.mock.calls[0]?.[0]).toBe(true);
          expect(respond.mock.calls[0]?.[1]).toMatchObject(
            method === "sessions.describe"
              ? { session: { sessionId: "reload", thinkingDefault: "high" } }
              : { sessionId: "reload", processes: [] },
          );
          const consume = vi.fn(() => old.run(() => undefined));
          await expect(
            projection.withPreparedExactRows(() => [{ key, agentId: "main" }], consume),
          ).rejects.toThrow("reloaded or disabled");
          expect(consume).toHaveBeenCalledOnce();
        }
      } finally {
        release?.();
        replacement.resolve();
        resume.resolve();
        await pending.catch(() => {});
      }
    });
  },
);
