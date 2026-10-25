import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
import { AgentSelectionRequiredError } from "../../agents/agent-scope-config.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { retainLegacyDefaultAgentId } from "../legacy.default-agent-owner.js";
import { setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import {
  appendTranscriptMessage,
  appendTranscriptMessageSync,
  ensureSessionEntrySync,
  loadSessionEntry,
  loadTranscriptEvents as loadEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import {
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.sqlite-entry.js";
import {
  appendTranscriptEventSync,
  replaceTranscriptEventsSync,
} from "./session-accessor.sqlite-transcript-write.test-support.js";
import { persistSessionTranscriptTurn as persistTurn } from "./session-accessor.transcript-turn.js";
import {
  SessionTranscriptWriterClaimReboundError,
  withOwnedSessionTranscriptWrites,
} from "./transcript-write-context.js";
import type { InternalSessionEntry } from "./types.js";

const fleetConfig = (storePath: string, owner?: string): OpenClawConfig => ({
  agents: {
    ownership: "explicit",
    ...(owner ? { defaults: { sessionStore: { agentId: owner } } } : {}),
    entries: { ops: {}, research: {} },
  },
  session: { store: storePath },
});

function turnOptions(config: OpenClawConfig, content: string) {
  return { config, messages: [message(content)], updateMode: "none" as const };
}

const message = (content: string, eventId?: string, role: "user" | "assistant" = "user") => ({
  eventId,
  message: { role, content },
});

function makeScope(dir: string, agentId?: string, sessionKey = "global", file = "sessions.json") {
  return { agentId, sessionId: "session", sessionKey, storePath: path.join(dir, file) };
}

function seed(scope: ReturnType<typeof makeScope>, fields: Partial<InternalSessionEntry> = {}) {
  return replaceSessionEntry(scope, { sessionId: scope.sessionId, updatedAt: 1, ...fields });
}

it.each([
  ["selection", false],
  ["selection", true],
  ["transaction", false],
  ["transaction", true],
] as const)("rejects revoked authority during %s (replay=%s)", async (phase, replay) => {
  await withTempHome(async (home) => {
    const scope = makeScope(home, "main", "agent:main:main");
    await seed(scope, { lifecycleRevision: "source-generation" });
    const append = message("completion", "source", "assistant");
    const options = {
      config: { session: { store: scope.storePath } },
      expectedSessionId: scope.sessionId,
      expectedLifecycleRevision: "source-generation",
      messages: [append],
      updateMode: "none" as const,
    };
    if (replay) {
      await persistTurn(scope, options);
    }
    const before = await loadEvents(scope);
    const entryBefore = loadSessionEntry(scope);
    let current = true;
    const committed = vi.fn();
    const revokeAt = (boundary: string) => {
      if (phase === boundary) {
        current = false;
      }
      return true;
    };
    const turn = withOwnedSessionTranscriptWrites(
      {
        sessionTarget: scope,
        assertCommitAllowed: () => {
          if (!current) {
            throw new Error("original source authority revoked");
          }
        },
        withTranscriptWrite: async (write) => await write(),
      },
      () =>
        persistTurn(scope, {
          ...options,
          messages: [
            {
              ...append,
              // Keep the async selection boundary distinct from the transaction guard.
              shouldAppend: async () => revokeAt("selection"),
              shouldAppendInTransaction: () => revokeAt("transaction"),
            },
          ],
          onMessageCommitted: committed,
        }),
    );
    await expect(turn).rejects.toThrow("original source authority revoked");
    expect(committed).not.toHaveBeenCalled();
    expect(await loadEvents(scope)).toEqual(before);
    expect(loadSessionEntry(scope)).toEqual(entryBefore);
  });
});

it("completes committed custody before a queued cancellation can interrupt the receipt", async () => {
  await withTempHome(async (home) => {
    const scope = makeScope(home, "main", "agent:main:main");
    await seed(scope);
    const controller = new AbortController();
    const completed: string[] = [];
    const turn = persistTurn(scope, {
      config: { session: { store: scope.storePath } },
      expectedSessionId: scope.sessionId,
      messages: [
        {
          ...message("notice", "committed", "assistant"),
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
    await expect(turn).resolves.toMatchObject({ messages: [{ appended: true }] });
    expect(controller.signal.aborted).toBe(true);
    expect(completed).toEqual(["committed"]);
    expect(await loadEvents(scope)).toContainEqual(expect.objectContaining({ id: "committed" }));
  });
});

it.each(["undesignated", "retired", "pathless injected"] as const)(
  "rejects an ownerless %s transcript write",
  async (kind) => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      const configured = fleetConfig(
        storePath,
        kind === "undesignated" ? undefined : kind === "retired" ? "retired" : "ops",
      );
      const cfg =
        kind === "undesignated" ? retainLegacyDefaultAgentId(configured, "ops") : configured;
      const scope = makeScope(home, undefined, kind === "undesignated" ? "main" : "global");
      const target =
        kind === "pathless injected"
          ? {
              sessionId: scope.sessionId,
              sessionKey: "global",
              sessionStore: { global: { sessionId: scope.sessionId, updatedAt: 1 } },
            }
          : scope;

      await expect(persistTurn(target, turnOptions(cfg, "must select"))).rejects.toBeInstanceOf(
        AgentSelectionRequiredError,
      );
    });
  },
);

it.each(["recorded default", "explicit per-agent store"] as const)(
  "attributes a write to its %s",
  async (kind) => {
    await withTempHome(async (home) => {
      const explicit = kind === "explicit per-agent store";
      const agentId = explicit ? "research" : "ops";
      const scope = makeScope(
        home,
        explicit ? agentId : undefined,
        explicit ? "global" : "main",
        explicit ? "research-sessions.json" : "sessions.json",
      );
      const cfg = fleetConfig(
        explicit ? path.join(home, "shared-sessions.json") : scope.storePath,
        explicit ? "ops" : undefined,
      );
      if (!explicit) {
        cfg.agents = { ...cfg.agents, defaults: { systemAgent: { agentId: "ops" } } };
        retainLegacyDefaultAgentId(cfg, "ops");
      }
      await seed({ ...scope, agentId });

      await expect(
        persistTurn(scope, {
          ...turnOptions(cfg, kind),
          ...(explicit ? { expectedSessionId: scope.sessionId } : {}),
        }),
      ).resolves.toMatchObject({ messages: [{ appended: true }] });
      await expect(loadEvents({ ...scope, agentId })).resolves.toContainEqual(
        expect.objectContaining({
          message: expect.objectContaining({ content: kind, role: "user" }),
          type: "message",
        }),
      );
    });
  },
);

it("rejects a conflicting scope agent for a persisted fixed-store owner", async () => {
  await withTempHome(async (home) => {
    const storePath = path.join(home, "sessions.json");
    const cfg = fleetConfig(storePath, "ops");
    const scope = makeScope(home, "research");

    await expect(persistTurn(scope, turnOptions(cfg, "wrong owner"))).rejects.toBeInstanceOf(
      AgentSelectionRequiredError,
    );

    await seed({ ...scope, agentId: "ops" });
    await expect(
      persistTurn({ ...scope, agentId: "ops" }, turnOptions(cfg, "right owner")),
    ).resolves.toMatchObject({ messages: [{ appended: true }] });
  });
});

it("completes a pathless injected write before a later failure", async () => {
  await withTempHome(async (home) => {
    const configuredStorePath = path.join(home, "shared-sessions.json");
    const sessionEntry = { sessionId: "injected-research", updatedAt: 1 };
    const sessionStore = { global: sessionEntry };
    const scope = { agentId: "research", sessionId: sessionEntry.sessionId, sessionKey: "global" };
    const cfg = fleetConfig(configuredStorePath, "ops");

    const completed: string[] = [];
    const accepted = createDeferredCore();
    const release = createDeferredCore();
    const settled: string[] = [];
    const turn = persistTurn(
      { ...scope, sessionStore },
      {
        config: cfg,
        messages: [
          message("injected research", "injected-first"),
          {
            ...message("cannot commit"),
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
    const outcome = turn.catch((error: unknown) => error);
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
    expect(await loadEvents({ ...scope, storePath: configuredStorePath })).toContainEqual(
      expect.objectContaining({ id: "injected-first" }),
    );
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
        persistTurn(
          makeScope(home, "research", "global", "shared-store-alias.sqlite"),
          turnOptions(cfg, "wrong owner"),
        ),
      ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
    });
  },
);

it.each(["writer", "lifecycle"] as const)(
  "fences transcript mutations with the admitted %s claim",
  async (claim) => {
    await withTempHome(async (home) => {
      const fence = {
        expectedLifecycleRevision: claim === "writer" ? "current-revision" : "superseded-revision",
        expectedWriterRunId: claim === "writer" ? "superseded-run" : "current-run",
      };
      const sensitivePeer = "+15551234567";
      const scope = makeScope(
        home,
        "main",
        `agent:main:owned-fence:${sensitivePeer}\n\x1b[31mspoof`,
      );
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
          sessionTarget: { ...scope, ...fence },
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
          const [replacementError, eventError, messageError] = [
            () => replaceTranscriptEventsSync(scope, []),
            () => appendTranscriptEventSync(scope, { type: "custom", id: "stale-event" }),
            () => appendTranscriptMessageSync(scope, message("late", "stale-message")),
          ].map(captureClaimError);
          const expectedCause = {
            actualSessionIdHash: redactIdentifier(scope.sessionId),
            agentIdHash: redactIdentifier(scope.agentId),
            code: "session-rebound",
            expectedSessionIdHash: redactIdentifier(scope.sessionId),
            sessionKeyHash: redactIdentifier(scope.sessionKey),
          };
          for (const error of [eventError, messageError]) {
            expect(error).toMatchObject({ cause: expectedCause });
          }
          await expect(
            appendTranscriptMessage(
              { ...scope, ...fence },
              message("late async append", "stale-async-message"),
            ),
          ).rejects.toMatchObject({
            name: "SessionTranscriptWriterClaimReboundError",
            cause: expectedCause,
          });
          for (const error of [replacementError, eventError, messageError]) {
            expect(error).toBeInstanceOf(SessionTranscriptWriterClaimReboundError);
            const formatted = formatErrorMessage(error);
            for (const secret of [scope.sessionKey, sensitivePeer, "spoof", "\n", "\x1b"]) {
              expect(formatted).not.toContain(secret);
            }
          }
        },
      );

      expect(loadSessionEntry(scope)?.updatedAt).toBe(1);
      await expect(loadEvents(scope)).resolves.toEqual([]);
    });
  },
);
it.each(["authority", "idempotency"] as const)(
  "commits a %s-guarded turn without decoding unrelated tool results",
  async (guardKind) => {
    await withOpenClawTestState({ label: "guarded-turn-write-hold" }, async (state) => {
      setRuntimeConfigSnapshot({});
      const scope = makeScope(state.sessionsDir(), "main", "agent:main:guarded-turn");
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      appendTranscriptMessageSync(scope, {
        message: {
          role: "toolResult",
          toolCallId: "large-result",
          toolName: "read",
          content: [{ type: "text", text: "synthetic tool output ".repeat(8000) }],
          isError: false,
          timestamp: 1,
        },
      });
      const codec = expectDefined(
        resolveZstdCodec(),
        "Transcript hold regression requires native zstd",
      );
      using decode = vi.spyOn(codec, "decompress");
      const guard = vi.fn(() => true);
      const committed = await persistTurn(scope, {
        expectedSessionId: scope.sessionId,
        updateMode: "none",
        touchSessionEntry: true,
        messages: [
          {
            message: {
              role: "assistant",
              content: "completed",
              timestamp: 2,
              idempotencyKey: "fresh-reply",
            },
            ...(guardKind === "authority"
              ? { shouldAppendInTransaction: guard }
              : { idempotencyLookup: "scan-assistant" as const }),
          },
        ],
      });
      expect(committed.messages.filter((m) => m.appended)).toHaveLength(1);
      expect(guard).toHaveBeenCalledTimes(guardKind === "authority" ? 1 : 0);
      expect(decode).not.toHaveBeenCalled();
    });
  },
);
