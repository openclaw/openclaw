import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  createGitLabManagedOAuthRecord,
  writeGitLabManagedOAuthRecord,
  type GitLabManagedOAuthRecord,
} from "../agents/gitlab-managed-records.js";
import { insertRegistryWorktree, updateRegistryWorktree } from "../agents/worktrees/registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.sqlite-entry.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { prepareGitHubPublicationSource } from "./github-publication-source.js";

const state = vi.hoisted(() => ({
  worktree: null as null | {
    id: string;
    path: string;
    repoRoot: string;
    repoFingerprint: string;
    branch: string;
  },
  entry: null as null | { sessionId: string; lifecycleRevision: string | null },
  remoteHead: null as null | string,
  pushes: 0,
  failFirstPush: false,
  applyBeforePushFailure: false,
}));
vi.mock("./github-publication-availability.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./github-publication-availability.js")>()),
  readGitHubPublicationWorktreeOwner: async () => ({
    worktree: state.worktree,
    assertCurrent: () => ({ loaded: { entry: state.entry } }),
    release() {},
    [Symbol.dispose]() {},
  }),
}));
vi.mock("../agents/worktrees/run-lease.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/worktrees/run-lease.js")>()),
  acquireWorktreeRunLease: async () => ({ release: async () => {} }),
}));
vi.mock("./gitlab-publication-git.js", async (original) => ({
  ...(await original<typeof import("./gitlab-publication-git.js")>()),
  observeGitLabPublicationHead: async () => state.remoteHead,
  pushGitLabPublicationCommit: async ({ git: preparedGit }: { git: { headCommit: string } }) => {
    state.pushes++;
    if (state.failFirstPush && state.pushes === 1) {
      if (state.applyBeforePushFailure) {
        state.remoteHead = preparedGit.headCommit;
      }
      throw new Error("Synthetic push response lost");
    }
    state.remoteHead = preparedGit.headCommit;
  },
}));

import { replaceUserGitLabConnection } from "../state/user-gitlab-connections.js";
import { disconnectedUserGitLabConnection } from "../state/user-gitlab-connections.kernel.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { readPersonalGitLabPublicationAsync } from "./github-publication-store-async.js";
import {
  managedGitLabPublicationGeneration,
  type GitLabPublicationCredential,
  type GitLabPublicationPublisher,
} from "./gitlab-personal-publication-identity.js";
import { readAcceptedGitLabPublication } from "./gitlab-personal-publication-row.js";
import {
  confirmPersonalGitLabPublication,
  readPersonalGitLabPublicationOptions,
  readPersonalGitLabPublicationStatus,
  requestPersonalGitLabPublication,
} from "./gitlab-personal-publication.js";

const issuer = "https://gitlab.example.test";
const project = {
  id: 17,
  path_with_namespace: "group/repo",
  http_url_to_repo: `${issuer}/group/repo.git`,
  web_url: `${issuer}/group/repo`,
  default_branch: "master",
};
const account = {
  issuer,
  accountId: 42,
  login: "alice",
  name: "Alice Human",
  commitEmail: "alice@example.test",
};
function git(cwd: string, ...args: string[]) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_CONFIG_SYSTEM: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

it.each([
  "lost-mr-response",
  "lost-first-push",
  "hidden-mr-after-loss",
  "unrelated-mr-after-loss",
  "markerless-mr-after-loss",
  "foreign-url-after-loss",
  "missing-source",
  "no-changes",
  "bootstrap-draft",
  "bootstrap-applied-push-loss",
  "bootstrap-existing-branch",
  "bootstrap-must-draft",
  "bootstrap-nonempty",
  "selected-base",
  "local-commits",
  "project-allowlist-omitted",
  "project-denied",
  "project-policy-revoked",
  "shared-native",
  "shared-agent-native",
] as const)("keeps native publication authority and exact Git state for %s", async (fault) =>
  withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-native-acceptance-"));
    try {
      setRuntimeConfigSnapshot({});
      git(cwd, "init", "--initial-branch=master");
      git(cwd, "config", "user.name", "Fixture");
      git(cwd, "config", "user.email", "fixture@example.test");
      await fs.writeFile(path.join(cwd, "artifact.txt"), "base\n");
      git(cwd, "add", "artifact.txt");
      git(cwd, "commit", "-m", "Synthetic source");
      const source = git(cwd, "rev-parse", "HEAD");
      git(cwd, "checkout", "-b", "topic");
      git(cwd, "remote", "add", "origin", project.http_url_to_repo);
      if (
        fault !== "no-changes" &&
        (!fault.startsWith("bootstrap-") || fault === "bootstrap-nonempty")
      ) {
        await fs.writeFile(path.join(cwd, "artifact.txt"), "accepted\n");
        git(cwd, "add", "artifact.txt");
      }
      if (fault === "local-commits") {
        git(cwd, "commit", "-m", "Unpublished task work");
      }
      const localHead = git(cwd, "rev-parse", "HEAD");
      const sessionId = randomUUID();
      const sessionKey = `agent:main:${sessionId}`;
      state.worktree = {
        id: randomUUID(),
        path: cwd,
        repoRoot: cwd,
        repoFingerprint: `fixture-${sessionId}`,
        branch: "topic",
      };
      await insertRegistryWorktree(process.env, {
        ...state.worktree,
        name: "topic",
        baseRef: "origin/master",
        ownerKind: "session",
        ownerId: sessionKey,
        createdAt: 1_000,
        lastActiveAt: 1_000,
      });
      const entry = await upsertSessionEntryCore(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: 1_000,
          worktree: { id: state.worktree.id, repoRoot: cwd, branch: "topic" },
        },
      );
      expect(entry).toBeDefined();
      state.entry = { sessionId, lifecycleRevision: entry?.lifecycleRevision ?? null };
      state.remoteHead = fault === "bootstrap-existing-branch" ? source : null;
      state.pushes = 0;
      state.failFirstPush = fault === "lost-first-push" || fault === "bootstrap-applied-push-loss";
      state.applyBeforePushFailure = fault === "bootstrap-applied-push-loss";
      const owner = ensureProfileForEmail(`gitlab-${fault}@example.test`).id;
      const publicationAccount =
        fault === "shared-native" || fault === "shared-agent-native"
          ? {
              ...account,
              login: "managed-bot",
              name: "Managed Bot",
              commitEmail: "managed-bot@example.test",
            }
          : account;
      let generation: string = randomUUID();
      let publisher: GitLabPublicationPublisher = { source: "personal" };
      let managedRecord: GitLabManagedOAuthRecord | undefined;
      if (fault === "shared-native" || fault === "shared-agent-native") {
        await replaceUserGitLabConnection(
          owner,
          issuer,
          undefined,
          disconnectedUserGitLabConnection(issuer),
          () => {},
        );
        const record = createGitLabManagedOAuthRecord({
          profileId: "glp_cccccccccccccccccccccccccccccccc",
          scope: fault === "shared-agent-native" ? "agent" : "system",
          agentId: "main",
          account: publicationAccount,
          tokens: {
            accessToken: "synthetic-token",
            refreshToken: "synthetic-refresh",
            expiresAtMs: Date.now() + 3600000,
            scopes: ["api", "write_repository"],
          },
        });
        await writeGitLabManagedOAuthRecord(record);
        managedRecord = record;
        publisher = {
          source: fault === "shared-agent-native" ? "agent-override" : "system-configured",
          profileId: record.profileId,
          recordCreatedAtMs: record.createdAtMs,
        };
        generation = managedGitLabPublicationGeneration({
          publisher,
          issuer,
          accountId: publicationAccount.accountId,
          login: publicationAccount.login,
        });
      } else {
        await replaceUserGitLabConnection(
          owner,
          issuer,
          undefined,
          {
            version: 1,
            issuer,
            generation,
            selection: {
              kind: "connected",
              account,
              tokens: {
                accessToken: "synthetic-token",
                refreshToken: "synthetic-refresh",
                expiresAtMs: Date.now() + 3600000,
                scopes: ["api"],
              },
            },
          },
          () => {},
        );
      }
      const requestId = randomUUID();
      const mrs: Array<Record<string, unknown>> = [];
      let posts = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = new URL(input instanceof Request ? input.url : input.toString());
          const endpoint = url.pathname.replace("/api/v4/", "");
          expect(url.origin).toBe(issuer);
          expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-token");
          if (endpoint === "user") {
            return Response.json({
              id: 42,
              username: publicationAccount.login,
              name: publicationAccount.name,
              commit_email: publicationAccount.commitEmail,
            });
          }
          if (endpoint === "projects/17") {
            return Response.json(project);
          }
          if (endpoint === "projects/group%2Frepo") {
            return Response.json(project);
          }
          if (
            endpoint === "projects/17/repository/branches/master" ||
            endpoint === "projects/17/repository/branches/develop"
          ) {
            return Response.json({
              name: endpoint.endsWith("/develop") ? "develop" : "master",
              commit: { id: source },
            });
          }
          if (endpoint === "projects/17/repository/branches/topic") {
            return state.remoteHead
              ? Response.json({ name: "topic", commit: { id: state.remoteHead } })
              : Response.json({}, { status: 404 });
          }
          if (endpoint === `projects/17/repository/commits/${source}`) {
            return Response.json({ id: source });
          }
          if (endpoint === "projects/17/merge_requests" && init?.method === "GET") {
            return Response.json(mrs);
          }
          if (endpoint === "projects/17/merge_requests" && init?.method === "POST") {
            posts++;
            const body = JSON.parse(typeof init.body === "string" ? init.body : "") as {
              description: string;
              title: string;
              target_branch: string;
            };
            expect(body.target_branch).toBe(fault === "selected-base" ? "develop" : "master");
            if (fault.startsWith("bootstrap-")) {
              expect(body.title).toBe("Draft: Publish accepted change");
            }
            mrs.push({
              iid: 9,
              web_url: `${project.web_url}/-/merge_requests/9`,
              state: "opened",
              source_project_id: 17,
              target_project_id: 17,
              source_branch: "topic",
              target_branch: body.target_branch,
              sha: state.remoteHead,
              author: { id: 42 },
              description: body.description,
            });
            if (fault !== "lost-first-push") {
              throw new Error("Synthetic MR response lost");
            }
            return Response.json(mrs[0]);
          }
          if (endpoint === "projects/17/merge_requests/9") {
            return Response.json(mrs[0]);
          }
          throw new Error(`Unexpected synthetic GitLab API request ${init?.method} ${endpoint}`);
        }),
      );
      const action = {
        owner,
        sessionId,
        sessionKey,
        agentId: "main",
        lifecycleRevision: state.entry.lifecycleRevision,
        version: 2,
        signal: new AbortController().signal,
        assertCurrent() {},
        prepareSource: (selector: Record<string, unknown>) =>
          prepareGitHubPublicationSource({
            sourcePath: resolveOpenClawAgentSqlitePath({ agentId: "main" }),
            selector: { ...selector, profileId: owner } as never,
            signal: new AbortController().signal,
            assertCurrent() {},
          }),
      };
      const credential: GitLabPublicationCredential = {
        publisher,
        account: publicationAccount,
        generation,
        assertCurrent() {},
        withToken: async <T>(run: (token: string) => Promise<T>) => run("synthetic-token"),
        close() {},
      };
      let projects: number[] | undefined =
        fault === "project-allowlist-omitted" || fault === "project-policy-revoked"
          ? undefined
          : fault === "project-denied"
            ? [99]
            : [17];
      const options = {
        context: {
          getRuntimeConfig: () => ({
            gateway: { gitlab: { issuer: `${issuer}/`, projects } },
          }),
          workerSessionPlacementService: {
            workspaceResultInstanceId: () => "gitlab-fixture-gateway",
            withLocalWorkspaceReservation: async (
              _: unknown,
              run: (assert: () => void) => Promise<unknown>,
            ) => run(() => {}),
          },
        },
      };
      const input = {
        sessionKey: action.sessionKey,
        idempotencyKey: requestId,
        title: "Publish accepted change",
        draft: fault === "bootstrap-must-draft" ? false : fault.startsWith("bootstrap-"),
        bootstrapDraft: fault.startsWith("bootstrap-"),
        baseBranch: fault === "selected-base" ? "develop" : undefined,
      };
      if (
        fault === "bootstrap-must-draft" ||
        fault === "bootstrap-existing-branch" ||
        fault === "bootstrap-nonempty"
      ) {
        await expect(
          requestPersonalGitLabPublication(options as never, action as never, credential, input),
        ).rejects.toThrow(
          fault === "bootstrap-must-draft"
            ? "must be a draft"
            : fault === "bootstrap-existing-branch"
              ? "requires an unpublished branch"
              : "requires an unchanged tree",
        );
        expect(
          await readPersonalGitLabPublicationAsync(owner, issuer, {
            sessionKey: action.sessionKey,
            agentId: action.agentId,
          }),
        ).toBeUndefined();
        expect(git(cwd, "rev-parse", "HEAD")).toBe(source);
        expect(state.pushes).toBe(0);
        expect(posts).toBe(0);
        return;
      }
      if (fault === "project-denied") {
        await expect(
          requestPersonalGitLabPublication(options as never, action as never, credential, input),
        ).rejects.toThrow("GitLab publication project is not allowed");
        expect(posts).toBe(0);
        expect(state.pushes).toBe(0);
        expect(git(cwd, "rev-parse", "HEAD")).toBe(source);
        return;
      }
      if (fault === "missing-source") {
        action.prepareSource = async () => {
          throw new Error("No native session source capability");
        };
        await expect(
          requestPersonalGitLabPublication(options as never, action as never, credential, input),
        ).rejects.toThrow("No native session source capability");
        expect(
          await readPersonalGitLabPublicationAsync(owner, issuer, {
            sessionKey: action.sessionKey,
            agentId: action.agentId,
          }),
        ).toBeUndefined();
        expect(posts).toBe(0);
        expect(state.pushes).toBe(0);
        expect(git(cwd, "rev-parse", "HEAD")).toBe(source);
        return;
      }
      const firstResult = await requestPersonalGitLabPublication(
        options as never,
        action as never,
        credential,
        input,
      );
      if (fault === "no-changes") {
        expect(firstResult).toMatchObject({ status: "failed", code: "no_changes" });
        expect(
          (
            await readPersonalGitLabPublicationStatus(
              options as never,
              action as never,
              null,
              firstResult.requestId,
            )
          ).result,
        ).toMatchObject({ status: "failed", code: "no_changes" });
        expect(
          await requestPersonalGitLabPublication(
            options as never,
            action as never,
            credential,
            input,
          ),
        ).toMatchObject({ status: "failed", code: "no_changes" });
        expect(git(cwd, "rev-parse", "HEAD")).toBe(source);
        expect(posts).toBe(0);
        expect(state.pushes).toBe(0);
        return;
      }
      expect(firstResult).toMatchObject({ status: "needs_confirmation" });
      const acceptedRequestId = firstResult.requestId;
      const first = await readPersonalGitLabPublicationAsync(owner, issuer, {
        requestId: acceptedRequestId,
      });
      expect(first?.status).toBe("needs_confirmation");
      if (fault === "lost-first-push") {
        const keyA = await readPersonalGitLabPublicationOptions(
          options as never,
          action as never,
          input.idempotencyKey,
        );
        expect(keyA.pendingPersonal?.result).toMatchObject({
          requestId: acceptedRequestId,
          status: "needs_confirmation",
        });
        const keyB = await readPersonalGitLabPublicationOptions(
          options as never,
          action as never,
          randomUUID(),
        );
        expect(keyB.pendingPersonal).toBeNull();
      }
      const saved = readAcceptedGitLabPublication(first!);
      if (fault.startsWith("bootstrap-")) {
        expect(saved).toMatchObject({
          bootstrapDraft: true,
          draft: true,
          previousHeadCommit: null,
        });
        expect(saved.workspaceHead).toBe(saved.baseTree);
        await expect(
          requestPersonalGitLabPublication(options as never, action as never, credential, {
            ...input,
            bootstrapDraft: false,
          }),
        ).rejects.toThrow("different accepted GitLab publication");
      }
      const finalHead = first!.head_commit!;
      expect(saved.sourceHead).toBe(localHead);
      expect(finalHead).toMatch(/^[a-f0-9]{40}$/u);
      expect(finalHead).not.toBe(source);
      expect(git(cwd, "rev-parse", "HEAD")).toBe(finalHead);
      expect(git(cwd, "write-tree")).toBe(saved.workspaceHead);
      expect(git(cwd, "rev-parse", `${finalHead}^{tree}`)).toBe(saved.workspaceHead);
      expect(git(cwd, "show", "-s", "--format=%P", finalHead)).toBe(source);
      expect(git(cwd, "show", "-s", "--format=%an <%ae> (%cn <%ce>)", finalHead)).toBe(
        `${publicationAccount.name} <${publicationAccount.commitEmail}> (${publicationAccount.name} <${publicationAccount.commitEmail}>)`,
      );
      if (fault === "bootstrap-applied-push-loss") {
        expect(posts).toBe(0);
        expect(state.pushes).toBe(1);
        expect(state.remoteHead).toBe(finalHead);
        const status = await readPersonalGitLabPublicationStatus(
          options as never,
          action as never,
          credential,
          acceptedRequestId,
        );
        expect(status.confirmation).not.toBeNull();
        expect(
          await confirmPersonalGitLabPublication(options as never, action as never, credential, {
            requestId: acceptedRequestId,
            ...status.confirmation!,
          } as never),
        ).toMatchObject({ status: "needs_confirmation" });
        expect(posts).toBe(1);
        expect(state.pushes).toBe(1);
        expect(
          await confirmPersonalGitLabPublication(options as never, action as never, credential, {
            requestId: acceptedRequestId,
            ...status.confirmation!,
          } as never),
        ).toMatchObject({ status: "published", headCommit: finalHead });
        expect(posts).toBe(1);
        expect(state.pushes).toBe(1);
        return;
      }
      if (fault === "shared-native" || fault === "shared-agent-native") {
        expect(saved.publisher).toEqual(publisher);
        expect(first?.connection_generation).toBe(generation);
        expect(first?.owner_profile_id).toBe(owner);
        const otherOwner = ensureProfileForEmail(`gitlab-${fault}-collaborator@example.test`).id;
        const collaborator = { ...action, owner: otherOwner };
        const collaboratorOptions = await readPersonalGitLabPublicationOptions(
          options as never,
          collaborator as never,
        );
        expect(collaboratorOptions.pendingPersonal).toBeNull();
        expect(collaboratorOptions.latestShared?.result).toMatchObject({
          requestId: acceptedRequestId,
          publisher: { source: publisher.source, login: publicationAccount.login },
        });
        await expect(
          requestPersonalGitLabPublication(options as never, collaborator as never, credential, {
            ...input,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toThrow("unresolved");
        const personalSameActor: GitLabPublicationCredential = {
          ...credential,
          publisher: { source: "personal" },
        };
        expect(
          (
            await readPersonalGitLabPublicationStatus(
              options as never,
              action as never,
              personalSameActor,
              acceptedRequestId,
            )
          ).result,
        ).toMatchObject({
          status: "failed",
          code: "identity_changed",
          publisher: { source: publisher.source, login: publicationAccount.login },
        });
        await expect(
          requestPersonalGitLabPublication(
            options as never,
            action as never,
            personalSameActor,
            input,
          ),
        ).rejects.toThrow("different accepted GitLab publication");
        const status = await readPersonalGitLabPublicationStatus(
          options as never,
          action as never,
          credential,
          acceptedRequestId,
        );
        await expect(
          confirmPersonalGitLabPublication(options as never, action as never, personalSameActor, {
            requestId: acceptedRequestId,
            ...status.confirmation!,
          } as never),
        ).rejects.toThrow("confirmation no longer matches");
        const interrupted = { ...managedRecord!, refreshClaim: randomUUID() };
        await writeGitLabManagedOAuthRecord(interrupted, managedRecord);
        await expect(
          confirmPersonalGitLabPublication(options as never, action as never, credential, {
            requestId: acceptedRequestId,
            ...status.confirmation!,
          } as never),
        ).rejects.toThrow("identity changed");
        expect(posts).toBe(1);
        await writeGitLabManagedOAuthRecord(managedRecord!, interrupted);
        expect(
          await confirmPersonalGitLabPublication(
            options as never,
            collaborator as never,
            credential,
            {
              requestId: acceptedRequestId,
              ...status.confirmation!,
            } as never,
          ),
        ).toMatchObject({
          status: "published",
          publisher: { source: publisher.source, login: publicationAccount.login },
        });
        expect(
          (
            await readPersonalGitLabPublicationAsync(owner, issuer, {
              requestId: acceptedRequestId,
            })
          )?.owner_profile_id,
        ).toBe(owner);
        const publishedOptions = await readPersonalGitLabPublicationOptions(
          options as never,
          collaborator as never,
        );
        expect(publishedOptions.pendingPersonal).toBeNull();
        expect(publishedOptions.latestShared?.result).toMatchObject({
          status: "published",
          requestId: acceptedRequestId,
          url: `${project.web_url}/-/merge_requests/9`,
          headCommit: finalHead,
          publisher: {
            source: publisher.source,
            accountId: publicationAccount.accountId,
            login: publicationAccount.login,
          },
        });
        const originalWorktree = state.worktree!;
        for (const changedWorktree of [
          { ...originalWorktree, id: randomUUID() },
          { ...originalWorktree, repoFingerprint: `replacement-${randomUUID()}` },
          { ...originalWorktree, branch: "another-branch" },
        ]) {
          state.worktree = changedWorktree;
          expect(
            (await readPersonalGitLabPublicationOptions(options as never, collaborator as never))
              .latestShared,
          ).toBeNull();
        }
        state.worktree = originalWorktree;
        await updateRegistryWorktree(process.env, originalWorktree.id, {
          removedAt: Date.now(),
        });
        expect(
          (await readPersonalGitLabPublicationOptions(options as never, collaborator as never))
            .latestShared,
        ).toBeNull();
        expect(
          (
            await readPersonalGitLabPublicationStatus(
              options as never,
              collaborator as never,
              null,
              acceptedRequestId,
            )
          ).result,
        ).toMatchObject({ status: "published", requestId: acceptedRequestId });
        expect(posts).toBe(1);
        return;
      }
      if (fault === "lost-mr-response") {
        const otherOwner = ensureProfileForEmail("gitlab-private-collaborator@example.test").id;
        const otherOptions = await readPersonalGitLabPublicationOptions(
          options as never,
          { ...action, owner: otherOwner } as never,
        );
        expect(otherOptions.pendingPersonal).toBeNull();
        expect(otherOptions.latestShared).toBeNull();
        await expect(
          readPersonalGitLabPublicationStatus(
            options as never,
            { ...action, owner: otherOwner } as never,
            null,
            acceptedRequestId,
          ),
        ).rejects.toThrow("not found");
        await expect(
          requestPersonalGitLabPublication(options as never, action as never, credential, {
            ...input,
            idempotencyKey: randomUUID(),
          }),
        ).rejects.toThrow(/unresolved/);
        expect(
          await readPersonalGitLabPublicationAsync(owner, issuer, {
            sessionKey: action.sessionKey,
            agentId: action.agentId,
          }),
        ).toMatchObject({ request_id: acceptedRequestId });
        await expect(
          readPersonalGitLabPublicationStatus(
            options as never,
            { ...action, sessionId: randomUUID() } as never,
            credential,
            acceptedRequestId,
          ),
        ).rejects.toThrow("another session");
        expect(
          (
            await readPersonalGitLabPublicationStatus(
              options as never,
              action as never,
              { ...credential, account: { ...account, accountId: 99, login: "bob" } },
              acceptedRequestId,
            )
          ).result,
        ).toMatchObject({ status: "failed", code: "identity_changed" });
        await expect(
          confirmPersonalGitLabPublication(options as never, action as never, credential, {
            requestId: acceptedRequestId,
            requestDigest: first!.request_digest,
            generation,
            account: { accountId: 99, login: "bob" },
          } as never),
        ).rejects.toThrow();
        expect(posts).toBe(1);
      }
      if (
        fault === "hidden-mr-after-loss" ||
        fault === "unrelated-mr-after-loss" ||
        fault === "markerless-mr-after-loss" ||
        fault === "foreign-url-after-loss"
      ) {
        if (fault === "hidden-mr-after-loss") {
          mrs.length = 0;
        } else if (fault === "unrelated-mr-after-loss") {
          (mrs[0]!.author as { id: number }).id = 99;
        } else if (fault === "markerless-mr-after-loss") {
          mrs[0]!.description = "Unrelated description";
        } else {
          mrs[0]!.web_url = `${issuer}/other/repo/-/merge_requests/9`;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          expect(
            await requestPersonalGitLabPublication(
              options as never,
              action as never,
              credential,
              input,
            ),
          ).toMatchObject({ status: "needs_confirmation", requestId: acceptedRequestId });
          expect(
            (
              await readPersonalGitLabPublicationAsync(owner, issuer, {
                requestId: acceptedRequestId,
              })
            )?.status,
          ).toBe("needs_confirmation");
          expect(posts).toBe(1);
          expect(state.pushes).toBe(1);
        }
        return;
      }
      if (fault === "project-policy-revoked") {
        projects = [99];
        const status = await readPersonalGitLabPublicationStatus(
          options as never,
          action as never,
          credential,
          acceptedRequestId,
        );
        await expect(
          confirmPersonalGitLabPublication(options as never, action as never, credential, {
            requestId: acceptedRequestId,
            ...status.confirmation!,
          } as never),
        ).rejects.toThrow("GitLab publication project is not allowed");
        expect(posts).toBe(1);
        expect(state.pushes).toBe(1);
        expect(
          (
            await readPersonalGitLabPublicationAsync(owner, issuer, {
              requestId: acceptedRequestId,
            })
          )?.status,
        ).toBe("needs_confirmation");
        return;
      }
      const repeated = await requestPersonalGitLabPublication(
        options as never,
        action as never,
        credential,
        input,
      );
      expect(repeated).toMatchObject({
        status: firstResult.status,
        requestId: acceptedRequestId,
      });
      expect(posts).toBe(fault === "lost-first-push" ? 0 : 1);
      const status = await readPersonalGitLabPublicationStatus(
        options as never,
        action as never,
        credential,
        acceptedRequestId,
      );
      if (fault !== "lost-first-push") {
        expect(status.confirmation).not.toBeNull();
        const observed = await confirmPersonalGitLabPublication(
          options as never,
          action as never,
          credential,
          { requestId: acceptedRequestId, ...status.confirmation! } as never,
        );
        expect(observed).toMatchObject({ status: "published", requestId: acceptedRequestId });
        expect(
          (
            await readPersonalGitLabPublicationAsync(owner, issuer, {
              requestId: acceptedRequestId,
            })
          )?.status,
        ).toBe("published");
        expect(posts).toBe(1);
        expect(state.pushes).toBe(1);
        return;
      }
      expect(status.confirmation).not.toBeNull();
      await fs.writeFile(path.join(cwd, "artifact.txt"), "changed after acceptance\n");
      git(cwd, "add", "artifact.txt");
      await expect(
        confirmPersonalGitLabPublication(options as never, action as never, credential, {
          requestId: acceptedRequestId,
          ...status.confirmation!,
        } as never),
      ).rejects.toThrow();
      expect(state.pushes).toBe(1);
      await fs.writeFile(path.join(cwd, "artifact.txt"), "accepted\n");
      git(cwd, "add", "artifact.txt");
      const result = await confirmPersonalGitLabPublication(
        options as never,
        action as never,
        credential,
        { requestId: acceptedRequestId, ...status.confirmation! } as never,
      );
      expect(result).toMatchObject({ status: "published", requestId: acceptedRequestId });
      expect(
        (
          await readPersonalGitLabPublicationAsync(owner, issuer, {
            requestId: acceptedRequestId,
          })
        )?.status,
      ).toBe("published");
      expect(git(cwd, "rev-parse", "HEAD")).toBe(finalHead);
      expect(git(cwd, "write-tree")).toBe(saved.workspaceHead);
      expect(git(cwd, "rev-parse", `${finalHead}^{tree}`)).toBe(saved.workspaceHead);
      expect(posts).toBe(1);
      expect(state.pushes).toBe(2);
      const disconnected = await replaceUserGitLabConnection(
        owner,
        issuer,
        generation,
        disconnectedUserGitLabConnection(issuer),
        () => {},
      );
      expect(disconnected.selection.kind).toBe("disconnected");
      expect(
        (
          await readPersonalGitLabPublicationStatus(
            options as never,
            action as never,
            null,
            acceptedRequestId,
          )
        ).result,
      ).toMatchObject({ status: "published", requestId: acceptedRequestId });
      const completedOptions = await readPersonalGitLabPublicationOptions(
        options as never,
        action as never,
        input.idempotencyKey,
      );
      expect(completedOptions.pendingPersonal?.result).toMatchObject({
        status: "published",
        requestId: acceptedRequestId,
      });
    } finally {
      clearRuntimeConfigSnapshot();
      vi.unstubAllGlobals();
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }),
);
