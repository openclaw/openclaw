import fs from "node:fs/promises";
import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  ensureSessionEntrySync,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
  replaceTranscriptEventsSync,
} from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { appendTranscriptEventSync } from "./session-accessor.sqlite-transcript-write.js";
import { persistSessionTranscriptTurn } from "./session-accessor.transcript-turn.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

function fleetConfig(storePath: string, owner?: string): OpenClawConfig {
  return {
    agents: {
      ownership: "explicit",
      ...(owner ? { defaults: { sessionStore: { agentId: owner } } } : {}),
      entries: { ops: {}, research: {} },
    },
    session: { store: storePath },
  };
}

function turnOptions(config: OpenClawConfig, content: string) {
  return {
    config,
    messages: [{ message: { role: "user", content } }],
    updateMode: "none" as const,
  };
}

describe("transcript turn logical ownership", () => {
  it("completes committed custody before a queued cancellation can interrupt the receipt", async () => {
    await withTempHome(async (home) => {
      const scope = {
        agentId: "main",
        sessionId: "commit-callback-session",
        sessionKey: "agent:main:main",
        storePath: path.join(home, "sessions.json"),
      };
      await replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const controller = new AbortController();
      const completed: string[] = [];
      const turn = persistSessionTranscriptTurn(scope, {
        config: { session: { store: scope.storePath } },
        expectedSessionId: scope.sessionId,
        messages: [
          {
            eventId: "committed-before-cancellation",
            message: { role: "assistant", content: "Committed notification" },
            shouldAppendInTransaction: () => {
              // Cancellation runs at the first async boundary after SQLite commit.
              queueMicrotask(() => controller.abort(new Error("cancelled after commit")));
              return true;
            },
          },
        ],
        onMessageCommitted: ({ messageId }) => {
          controller.signal.throwIfAborted();
          completed.push(messageId);
        },
        updateMode: "none",
      });
      await expect(turn).resolves.toMatchObject({ appendedCount: 1 });
      expect(controller.signal.aborted).toBe(true);
      expect(completed).toEqual(["committed-before-cancellation"]);
      expect(await loadTranscriptEvents(scope)).toContainEqual(
        expect.objectContaining({ id: "committed-before-cancellation" }),
      );
    });
  });

  it("rejects a bare-key write without a designation despite retained provenance", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainLegacyDefaultAgentId(
        {
          agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
          session: { store: storePath },
        } satisfies OpenClawConfig,
        "ops",
      );

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "ownerless-transcript-session",
            sessionKey: "main",
            storePath,
          },
          {
            config: cfg,
            messages: [{ message: { role: "user", content: "must not be attributed" } }],
            updateMode: "none",
          },
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });

  it("attributes a bare-key write to the recorded default owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = retainLegacyDefaultAgentId(
        {
          agents: {
            ownership: "explicit",
            defaults: { systemAgent: { agentId: "ops" } },
            entries: { ops: {}, research: {} },
          },
          session: { store: storePath },
        } satisfies OpenClawConfig,
        "ops",
      );
      const scope = {
        sessionId: "retained-owner-transcript-session",
        sessionKey: "main",
        storePath,
      };
      await replaceSessionEntry(
        { agentId: "ops", sessionKey: scope.sessionKey, storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      await expect(
        persistSessionTranscriptTurn(scope, turnOptions(cfg, "retained owner")),
      ).resolves.toMatchObject({ appendedCount: 1 });
      await expect(loadTranscriptEvents({ ...scope, agentId: "ops" })).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "retained owner", role: "user" }),
          type: "message",
        }),
      );
    });
  });

  it("rejects a conflicting scope agent for a persisted fixed-store owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = fleetConfig(storePath, "ops");
      const scope = {
        agentId: "research",
        sessionId: "persisted-owner-transcript-session",
        sessionKey: "global",
        storePath,
      };

      await expect(
        persistSessionTranscriptTurn(scope, turnOptions(cfg, "wrong owner")),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);

      await replaceSessionEntry(
        { agentId: "ops", sessionKey: scope.sessionKey, storePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );
      await expect(
        persistSessionTranscriptTurn({ ...scope, agentId: "ops" }, turnOptions(cfg, "right owner")),
      ).resolves.toMatchObject({ appendedCount: 1 });
    });
  });

  it("rejects a bare-key write for a retired persisted owner", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const cfg = fleetConfig(storePath, "retired");

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "retired-owner-transcript-session",
            sessionKey: "global",
            storePath,
          },
          turnOptions(cfg, "retired owner"),
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });

  it("allows an explicit agent write to a different per-agent store", async () => {
    await withTempHome(async (home) => {
      const fixedStorePath = path.join(home, "shared-sessions.json");
      const researchStorePath = path.join(home, "research-sessions.json");
      const cfg = fleetConfig(fixedStorePath, "ops");
      const scope = {
        agentId: "research",
        sessionId: "research-global-session",
        sessionKey: "global",
        storePath: researchStorePath,
      };
      await replaceSessionEntry(
        { agentId: "research", sessionKey: scope.sessionKey, storePath: researchStorePath },
        { sessionId: scope.sessionId, updatedAt: 1 },
      );

      await expect(
        persistSessionTranscriptTurn(scope, {
          ...turnOptions(cfg, "research store"),
          expectedSessionId: scope.sessionId,
        }),
      ).resolves.toMatchObject({ appendedCount: 1 });
      await expect(loadTranscriptEvents({ ...scope, agentId: "research" })).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: "research store", role: "user" }),
          type: "message",
        }),
      );
    });
  });

  it("completes a pathless injected write before a later failure", async () => {
    await withTempHome(async (home) => {
      const configuredStorePath = path.join(home, "shared-sessions.json");
      const sessionEntry = { sessionId: "injected-research", updatedAt: 1 };
      const sessionStore = { global: sessionEntry };
      const cfg = fleetConfig(configuredStorePath, "ops");

      const completed: string[] = [];
      const accepted = createDeferredCore();
      const release = createDeferredCore();
      const settled: string[] = [];
      const turn = persistSessionTranscriptTurn(
        {
          agentId: "research",
          sessionId: sessionEntry.sessionId,
          sessionKey: "global",
          sessionStore,
        },
        {
          config: cfg,
          messages: [
            {
              eventId: "injected-first",
              message: { role: "user", content: "injected research" },
            },
            {
              message: { role: "user", content: "cannot commit" },
              prepareMessageAfterIdempotencyCheck: () => {
                throw new Error("second append failed");
              },
            },
          ],
          onMessageCommitted: ({ messageId }, acceptCompletion) => {
            completed.push(messageId);
            acceptCompletion(async () => {
              accepted.resolve();
              await release.promise;
              settled.push(messageId);
            });
          },
          updateMode: "none",
        },
      );
      const outcome = turn.then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      try {
        expect(await Promise.race([accepted.promise.then(() => "accepted"), outcome])).toBe(
          "accepted",
        );
        expect(completed).toEqual(["injected-first"]);
        expect(settled).toEqual([]);
        release.resolve();
        await expect(turn).rejects.toThrow("second append failed");
      } finally {
        release.resolve();
        await outcome;
      }
      expect(completed).toEqual(["injected-first"]);
      expect(settled).toEqual(["injected-first"]);
      expect(
        await loadTranscriptEvents({
          agentId: "research",
          sessionId: sessionEntry.sessionId,
          sessionKey: "global",
          storePath: configuredStorePath,
        }),
      ).toContainEqual(expect.objectContaining({ id: "injected-first" }));
    });
  });

  it("keeps a pathless injected session store ownerless without an explicit agent", async () => {
    await withTempHome(async (home) => {
      const cfg = fleetConfig(path.join(home, "shared-sessions.json"), "ops");

      await expect(
        persistSessionTranscriptTurn(
          {
            sessionId: "injected-ownerless",
            sessionKey: "global",
            sessionStore: { global: { sessionId: "injected-ownerless", updatedAt: 1 } },
          },
          turnOptions(cfg, "must select"),
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  });

  it.runIf(process.platform !== "win32")(
    "treats a symlink alias as the configured owned fixed store",
    async () => {
      await withTempHome(async (home) => {
        const fixedStorePath = path.join(home, "shared-store.sqlite");
        const aliasStorePath = path.join(home, "shared-store-alias.sqlite");
        await fs.writeFile(fixedStorePath, "");
        await fs.symlink(fixedStorePath, aliasStorePath);
        const cfg = fleetConfig(fixedStorePath, "ops");

        await expect(
          persistSessionTranscriptTurn(
            {
              agentId: "research",
              sessionId: "aliased-store-session",
              sessionKey: "global",
              storePath: aliasStorePath,
            },
            turnOptions(cfg, "wrong owner"),
          ),
        ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
      });
    },
  );

  it.each([
    {
      name: "writer",
      fence: {
        expectedLifecycleRevision: "current-revision",
        expectedWriterRunId: "superseded-run",
      },
    },
    {
      name: "lifecycle",
      fence: {
        expectedLifecycleRevision: "superseded-revision",
        expectedWriterRunId: "current-run",
      },
    },
  ])("fences matching transcript mutations with the admitted $name claim", async ({ fence }) => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const sensitivePeer = "+15551234567";
      const scope = {
        agentId: "main",
        sessionId: "session-owned-fence",
        sessionKey: `agent:main:owned-fence:${sensitivePeer}\n\x1b[31mspoof`,
        storePath,
      };
      replaceSessionEntrySync(scope, {
        activeWriterRunId: "current-run",
        lifecycleRevision: "current-revision",
        sessionId: scope.sessionId,
        updatedAt: 1,
      } as InternalSessionEntry);

      await withOwnedSessionTranscriptWrites(
        {
          sessionFile: scope.sessionKey,
          sessionKey: scope.sessionKey,
          sessionTarget: {
            ...scope,
            ...fence,
          },
          withTranscriptWrite: async (run) => await run(),
        },
        async () => {
          expect(ensureSessionEntrySync(scope, { sessionId: scope.sessionId, updatedAt: 2 })).toBe(
            true,
          );
          const captureClaimError = (run: () => unknown): unknown => {
            try {
              run();
            } catch (error) {
              return error;
            }
            throw new Error("expected the writer claim to reject transcript persistence");
          };
          const replacementError = captureClaimError(() => replaceTranscriptEventsSync(scope, []));
          const eventError = captureClaimError(() =>
            appendTranscriptEventSync(scope, { type: "custom", id: "stale-event" }),
          );
          const messageError = captureClaimError(() =>
            appendTranscriptMessageSync(scope, {
              eventId: "stale-message",
              message: { role: "user", content: "late" },
            }),
          );
          const expectedCause = {
            actualSessionIdHash: redactIdentifier(scope.sessionId),
            agentIdHash: redactIdentifier(scope.agentId),
            code: "session-rebound",
            expectedSessionIdHash: redactIdentifier(scope.sessionId),
            sessionKeyHash: redactIdentifier(scope.sessionKey),
          };
          expect(eventError).toMatchObject({ cause: expectedCause });
          expect(messageError).toMatchObject({ cause: expectedCause });
          await expect(
            appendTranscriptMessage(
              { ...scope, ...fence },
              {
                eventId: "stale-async-message",
                message: { role: "user", content: "late async append" },
              },
            ),
          ).rejects.toMatchObject({
            name: "SessionTranscriptWriterClaimReboundError",
            cause: expectedCause,
          });
          for (const error of [replacementError, eventError, messageError]) {
            expect(error).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
            const formatted = formatErrorMessage(error);
            expect(formatted).not.toContain(scope.sessionKey);
            expect(formatted).not.toContain(sensitivePeer);
            expect(formatted).not.toContain("spoof");
            expect(formatted).not.toContain("\n");
            expect(formatted).not.toContain("\x1b");
          }
        },
      );

      expect(loadSessionEntry(scope)?.updatedAt).toBe(1);
      await expect(loadTranscriptEvents(scope)).resolves.toEqual([]);
    });
  });
});
