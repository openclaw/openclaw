import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { deleteSessionEntryLifecycle } from "../config/sessions.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import * as gitWorker from "../infra/git-worker.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  githubJson,
  loadTestSessionPullRequests as loadControlUiSessionPullRequests,
  pullListItem,
  requestUrl,
  routedFetch,
  testGitContext,
} from "./control-ui-session-prs.test-support.js";
import { loadGatewaySessionEntryReadOnly } from "./session-utils.js";

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("GH_TOKEN", "");
  vi.stubEnv("GITHUB_TOKEN", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it("marks retained PR data unavailable after a refresh fails, then recovers", async () => {
  vi.useRealTimers();
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const sessionKey = "agent:main:stale-preview";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      { sessionId: "stale-preview-session", updatedAt: 1 },
    );
    vi.useFakeTimers();
    try {
      let failed = false;
      const fetchImpl = routedFetch([
        {
          match: "/pulls?head=",
          response: () =>
            failed
              ? githubJson({ message: "Unavailable" }, 503)
              : githubJson([pullListItem({ state: "closed", merged_at: "2026-09-01T00:00:00Z" })]),
        },
      ]);
      const load = () =>
        loadControlUiSessionPullRequests(
          { sessionKey },
          {
            fetchImpl,
            resolveGitContext: async () => ({ ...testGitContext, branch: "stale-preview" }),
          },
        );
      const fresh = await load();
      expect(fresh.pullRequests[0]?.state).toBe("merged");
      failed = true;
      vi.advanceTimersByTime(91_000);
      const stale = await load();
      expect(stale.pullRequests).toEqual(fresh.pullRequests);
      expect(stale.status).toBe("unavailable");
      expect(stale.rateLimited).toBe(false);
      const calls = fetchImpl.mock.calls.length;
      expect(await load()).toEqual(stale);
      expect(fetchImpl.mock.calls).toHaveLength(calls);
      failed = false;
      vi.advanceTimersByTime(31_000);
      const recovered = await load();
      expect(recovered.status).not.toBe("unavailable");
      expect(recovered.pullRequests).toEqual(fresh.pullRequests);
    } finally {
      vi.useRealTimers();
    }
  });
});

it("discards a replaced session after Git capture without poisoning the replacement cache", async () => {
  vi.useRealTimers();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const owner = ensureProfileForEmail("original-pr-reader@example.test");
    const replacementOwner = ensureProfileForEmail("replacement-pr-reader@example.test");
    const sessionKey = "agent:main:replaced-pr-snapshot";
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId: "original-pr-session",
      updatedAt: 1,
      visibility: "shared",
      spawnedCwd: state.workspaceDir,
      createdActor: { type: "human", source: "profile", id: owner.id },
    });
    const captured = createDeferred();
    const release = createDeferred();
    const gitContext = { ...testGitContext, branch: "same-branch-after-replacement" };
    let title = "Retired session result";
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              title,
              state: "closed",
              merged_at: "2026-09-01T00:00:00Z",
            }),
          ]),
      },
    ]);
    const pending = loadControlUiSessionPullRequests(
      { sessionKey },
      {
        fetchImpl,
        resolveGitContext: async () => {
          captured.resolve();
          await release.promise;
          return gitContext;
        },
      },
    ).then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    try {
      await Promise.race([
        captured.promise,
        pending.then(() => {
          throw new Error("PR read settled before the Git-context barrier");
        }),
      ]);
      const original = loadGatewaySessionEntryReadOnly(sessionKey, { agentId: "main" });
      await expect(
        deleteSessionEntryLifecycle({
          agentId: "main",
          storePath: original.storePath,
          target: { canonicalKey: original.canonicalKey, storeKeys: original.storeKeys },
          expectedSessionId: "original-pr-session",
          archiveTranscript: false,
        }),
      ).resolves.toMatchObject({ deleted: true });
      await upsertSessionEntryCore(scope, {
        sessionId: "replacement-pr-session",
        updatedAt: 2,
        visibility: "draft",
        spawnedCwd: state.workspaceDir,
        createdActor: { type: "human", source: "profile", id: replacementOwner.id },
      });
      release.resolve();
      const retired = await pending;
      expect.soft(retired.ok).toBe(false);
      expect.soft(fetchImpl).not.toHaveBeenCalled();

      title = "Replacement session result";
      const loadReplacement = () =>
        loadControlUiSessionPullRequests(
          { sessionKey },
          { fetchImpl, resolveGitContext: async () => gitContext },
        );
      const replacement = await loadReplacement();
      expect.soft(replacement.pullRequests[0]?.title).toBe("Replacement session result");
      expect(fetchImpl.mock.calls).toHaveLength(1);
      expect(await loadReplacement()).toEqual(replacement);
      expect(fetchImpl.mock.calls).toHaveLength(1);
    } finally {
      release.resolve();
      await pending;
    }
  });
});

it("keeps a pending PR read and its warm cache through ordinary session metadata updates", async () => {
  vi.useRealTimers();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:active-pr-snapshot";
    const scope = { agentId: "main", sessionKey };
    await upsertSessionEntryCore(scope, {
      sessionId: "active-pr-session",
      updatedAt: 1,
      spawnedCwd: state.workspaceDir,
    });
    const captured = createDeferred();
    const release = createDeferred();
    const fetchImpl = routedFetch([
      {
        match: "/pulls?head=",
        response: () =>
          githubJson([
            pullListItem({
              title: "Current session result",
              state: "closed",
              merged_at: "2026-09-01T00:00:00Z",
            }),
          ]),
      },
    ]);
    const load = () =>
      loadControlUiSessionPullRequests(
        { sessionKey },
        {
          fetchImpl,
          resolveGitContext: async () => {
            captured.resolve();
            await release.promise;
            return { ...testGitContext, branch: "active-pr-snapshot" };
          },
        },
      );
    const pending = load();
    try {
      await Promise.race([
        captured.promise,
        pending.then(() => {
          throw new Error("PR read settled before the Git-context barrier");
        }),
      ]);
      await upsertSessionEntryCore(scope, { updatedAt: 2, label: "Still the same session" });
      release.resolve();
      const result = await pending;
      expect(result.pullRequests[0]?.title).toBe("Current session result");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(await load()).toEqual(result);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      release.resolve();
      await pending.catch(() => {});
    }
  });
});

it("retires a repository-only target without falling back to its local workspace", async () => {
  vi.useRealTimers();
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const sessionKey = "agent:main:repository-only";
    const repositories = getSessionRepositoryWorkspaceStore();
    const repository = repositories.create({
      agentId: "main",
      sessionKey,
      url: "https://github.com/openclaw/openclaw",
      branch: "repository-only",
      assertCurrent: () => {},
    });
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey },
      {
        sessionId: "repository-only-pr",
        updatedAt: 1,
        spawnedCwd: state.workspaceDir,
        repositoryWorkspaceId: repository.workspaceId,
      },
    );
    const fetchImpl = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(requestUrl(input));
      if (url.pathname.endsWith("/pulls")) {
        return githubJson([
          pullListItem({ state: "closed", head: {}, additions: 1, deletions: 0 }),
        ]);
      }
      if (url.pathname.endsWith("/pulls/103469")) {
        return githubJson({ additions: 1, deletions: 0 });
      }
      throw new Error(`Unexpected repository-only request: ${url.pathname}`);
    });
    const git = vi.spyOn(gitWorker, "runGitWorkerOperation");
    try {
      const result = await loadControlUiSessionPullRequests({ sessionKey }, { fetchImpl });
      expect(result.pullRequests).toMatchObject([{ number: 103469, state: "closed" }]);
      expect(new URL(requestUrl(fetchImpl.mock.calls[0]?.[0])).searchParams.get("head")).toBe(
        "openclaw:repository-only",
      );
      expect(git).not.toHaveBeenCalled();
      const fetched = fetchImpl.mock.calls.length;
      await repositories.delete({ workspaceId: repository.workspaceId, assertCurrent: () => {} });
      expect(await loadControlUiSessionPullRequests({ sessionKey }, { fetchImpl })).toEqual({
        pullRequests: [],
        rateLimited: false,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(fetched);
      expect(git).not.toHaveBeenCalled();
    } finally {
      git.mockRestore();
    }
  });
});

it.each(["alias replacement", "physical close", "same-file reopen"] as const)(
  "discards pending PR work after %s even when persisted rows are identical",
  async (change) => {
    vi.useRealTimers();
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const sessionKey = "agent:main:physical-pr-source";
      const original = state.statePath("original", "sessions.sqlite");
      const replacement = state.statePath("replacement", "sessions.sqlite");
      const aliasDirectory = state.statePath("selected");
      const alias = state.statePath("selected", "sessions.sqlite");
      for (const storePath of [original, replacement]) {
        await upsertSessionEntryCore(
          { agentId: "main", storePath, sessionKey },
          { sessionId: "identical-pr-session", updatedAt: 1, spawnedCwd: state.workspaceDir },
        );
        await closeOpenClawAgentDatabaseByPathAsync(storePath);
      }
      fs.symlinkSync(state.statePath("original"), aliasDirectory, "junction");
      const cfg = {
        session: { store: alias },
        agents: { entries: { main: { workspace: state.workspaceDir } } },
      };
      await state.writeConfig(cfg);
      setRuntimeConfigSnapshot(cfg);
      const entered = createDeferred();
      const release = createDeferred();
      const fetchImpl = vi.fn<typeof fetch>();
      const pending = loadControlUiSessionPullRequests(
        { sessionKey },
        {
          fetchImpl,
          resolveGitContext: async () => {
            entered.resolve();
            await release.promise;
            return testGitContext;
          },
        },
      ).then(
        () => true,
        () => false,
      );
      try {
        await Promise.race([
          entered.promise,
          pending.then(() => {
            throw new Error("PR read settled before source capture");
          }),
        ]);
        if (change === "alias replacement") {
          fs.rmSync(aliasDirectory);
          fs.symlinkSync(state.statePath("replacement"), aliasDirectory, "junction");
        } else {
          await closeOpenClawAgentDatabaseByPathAsync(original);
          if (change === "same-file reopen") {
            openOpenClawAgentDatabase({ agentId: "main", path: original });
          }
        }
        release.resolve();
        expect(await pending).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        release.resolve();
        await pending;
      }
    });
  },
);
