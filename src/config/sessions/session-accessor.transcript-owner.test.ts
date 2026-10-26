import fs from "node:fs/promises";
import path from "node:path";
import { redactIdentifier } from "@openclaw/normalization-core/node-crypto";
import { withTempHome } from "openclaw/plugin-sdk/test-env";
import { expect, it, vi } from "vitest";
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
  loadTranscriptEvents as loadEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
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
] as const)("rejects revoked authority during %s (replay=%s)", (phase, replay) =>
  withTempHome(async (home) => {
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
  }),
);

it("completes committed custody before a queued cancellation can interrupt the receipt", () =>
  withTempHome(async (home) => {
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
  }));

it.each([
  ["undesignated", undefined, undefined, false],
  ["retired", "retired", undefined, false],
  ["pathless injected", "ops", undefined, false],
  ["recorded default", undefined, undefined, true],
  ["explicit per-agent store", "ops", "research", true],
  ["fixed owner", "ops", "ops", true],
  ["conflicting owner", "ops", "research", false],
] as const)("resolves transcript ownership: %s", (kind, owner, agentId, allowed) =>
  withTempHome(async (home) => {
    const legacy = !owner;
    const separate = kind === "explicit per-agent store";
    const scope = makeScope(
      home,
      agentId,
      legacy ? "main" : "global",
      separate ? "research-sessions.json" : "sessions.json",
    );
    const cfg = fleetConfig(
      separate ? path.join(home, "shared-sessions.json") : scope.storePath,
      owner,
    );
    if (legacy) {
      if (allowed) {
        cfg.agents = { ...cfg.agents, defaults: { systemAgent: { agentId: "ops" } } };
      }
      retainLegacyDefaultAgentId(cfg, "ops");
    }
    const target =
      kind === "pathless injected"
        ? {
            sessionId: scope.sessionId,
            sessionKey: "global",
            sessionStore: { global: { sessionId: scope.sessionId, updatedAt: 1 } },
          }
        : scope;
    if (allowed) {
      await seed({ ...scope, agentId: agentId ?? "ops" });
    }
    const turn = persistTurn(target, {
      ...turnOptions(cfg, kind),
      ...(separate ? { expectedSessionId: scope.sessionId } : {}),
    });
    if (!allowed) {
      await expect(turn).rejects.toBeInstanceOf(AgentSelectionRequiredError);
      return;
    }
    await expect(turn).resolves.toMatchObject({ messages: [{ appended: true }] });
    await expect(loadEvents({ ...scope, agentId: agentId ?? "ops" })).resolves.toContainEqual(
      expect.objectContaining({
        message: expect.objectContaining({ content: kind, role: "user" }),
        type: "message",
      }),
    );
  }),
);

it.runIf(process.platform !== "win32")("rejects a conflicting owner through a store symlink", () =>
  withTempHome(async (home) => {
    const storePath = path.join(home, "shared-store.sqlite");
    const scope = makeScope(home, "research", "global", "alias.sqlite");
    await fs.writeFile(storePath, "");
    await fs.symlink(storePath, scope.storePath);
    await expect(
      persistTurn(scope, turnOptions(fleetConfig(storePath, "ops"), "wrong owner")),
    ).rejects.toBeInstanceOf(AgentSelectionRequiredError);
  }),
);

it("completes a pathless injected write before a later failure", () =>
  withTempHome(async (home) => {
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
  }));

it.each(["writer", "lifecycle"] as const)(
  "fences transcript mutations with the admitted %s claim",
  (claim) =>
    withTempHome(async (home) => {
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
    }),
);
