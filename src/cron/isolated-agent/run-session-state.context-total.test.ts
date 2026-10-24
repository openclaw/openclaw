// Verifies that cron run finalization supersedes the per-call context totals a run publishes.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSessionEntry, replaceSessionEntry } from "../../config/sessions/session-accessor.js";
import { SESSION_TOTAL_TOKENS_VERSION, type SessionEntry } from "../../config/sessions/types.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createCronSessionRowWriter } from "./run-prepare-runtime.js";
import { createPersistCronSessionEntry, type MutableCronSession } from "./run-session-state.js";

describe("createPersistCronSessionEntry context total", () => {
  it.each([120_000, undefined])(
    "persists final context total %s over a per-call total through the cron row writer",
    async (totalTokens) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const scope = {
          agentId: "main",
          storePath: path.join(state.agentDir(), "openclaw-agent.sqlite"),
          sessionKey: "agent:main:cron:job",
        };
        const lifecycleRevision = "00000000-0000-4000-8000-000000000003";
        const existingEntry: SessionEntry = {
          sessionId: "run-session-id",
          updatedAt: 1000,
          systemSent: true,
          lifecycleRevision,
          totalTokens: 900,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        };
        await replaceSessionEntry(scope, existingEntry);
        const cronSession = {
          storePath: scope.storePath,
          store: {},
          sessionEntry: { ...existingEntry },
          systemSent: true,
          isNewSession: true,
          previousSessionId: undefined,
          initialSessionEntry: existingEntry,
          lifecycleRevision,
        } as MutableCronSession;
        const read = () => loadSessionEntry({ ...scope, readConsistency: "latest" });
        const persist = createPersistCronSessionEntry({
          cronSession,
          agentSessionKey: scope.sessionKey,
          workspaceDir: state.home,
          persistSessionEntry: createCronSessionRowWriter({
            agentId: scope.agentId,
            agentSessionKey: scope.sessionKey,
          }),
        });

        // Ordinary snapshot writes preserve a per-call publication.
        await replaceSessionEntry(scope, { ...existingEntry, totalTokens: 185_000 });
        await persist();
        expect(read()?.totalTokens).toBe(185_000);

        // Final accounting wins for context only; concurrent user metadata survives.
        await replaceSessionEntry(scope, {
          ...read()!,
          totalTokens: 190_000,
          label: "Renamed during the run",
        });
        cronSession.sessionEntry.totalTokens = totalTokens;
        cronSession.sessionEntry.totalTokensFresh = totalTokens !== undefined;
        cronSession.sessionEntry.totalTokensVersion =
          totalTokens !== undefined ? SESSION_TOTAL_TOKENS_VERSION : undefined;
        cronSession.contextTotalsAccounted = true;
        await persist();
        expect(read()).toMatchObject({
          totalTokensFresh: totalTokens !== undefined,
          label: "Renamed during the run",
        });
        expect(read()?.totalTokens).toBe(totalTokens);
        expect(read()?.totalTokensVersion).toBe(
          totalTokens !== undefined ? SESSION_TOTAL_TOKENS_VERSION : undefined,
        );
        expect(cronSession.sessionEntry.totalTokens).toBe(totalTokens);

        // The finalization override is consumed by its acknowledged write.
        await replaceSessionEntry(scope, {
          ...read()!,
          totalTokens: 125_000,
          totalTokensFresh: true,
        });
        await persist();
        expect(read()?.totalTokens).toBe(125_000);
      });
    },
  );
});
