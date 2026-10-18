// Install the existing synthetic GitHub transport before loading publication owners.
// oxfmt-ignore
import {
  createPublicationActionFixture as fixture,
  publicationCheckpoint as checkpoint,
} from "./github-publication-actions.test-support.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { addSessionMember } from "../config/sessions/session-sharing-store.js";
import {
  ensureCanonicalUserProfileForEmail,
  setCanonicalUserProfileRole,
} from "../state/user-profile-writes.js";
import { guestScopes } from "./github-publication-requester.test-support.js";
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createOperatorWsClient } from "./server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { resolveSessionMutationAuthorizationAsync } from "./session-sharing-authorization-async.js";

const mocks = githubPublicationTestMocks();

describe("session PR actions through the agent tool and registered Gateway method", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["local", "repository"] as const)(
    "posts only the fixed re-review command for the guest's current %s PR",
    async (backend) => {
      const f = await fixture(backend);
      const checkpointsBefore = checkpoint.mock.calls.length;
      const result = await f.invoke("guest", { action: "request_review", ...f.expected });
      expect(result.details).toMatchObject({
        publication: f.publication,
        headCommit: f.publication.headCommit,
        reviewRequest: {
          status: "posted",
          url: `${f.publication.url}#issuecomment-123`,
          message:
            "ClawSweeper re-review request posted; review acceptance and completion are not confirmed.",
        },
      });
      expect(f.writes).toEqual([
        { action: "request_review", input: { body: "@clawsweeper re-review" } },
      ]);
      expect(checkpoint.mock.calls.length).toBe(checkpointsBefore);
    },
  );

  it("rejects target selectors, freeform commands and missing preconditions through both entry points", async () => {
    const f = await fixture();
    const args = { action: "request_review", ...f.expected };
    for (const extra of [
      { publishingSessionKey: "agent:main:child" },
      { body: "@clawsweeper re-review focus on permissions" },
      { title: "Unexpected metadata edit" },
      { command: "@clawsweeper stop" },
      { repository: "other/repo" },
      { mergeMethod: "merge" },
    ]) {
      for (const raw of [false, true]) {
        await expect(
          f.invoke("guest", { ...args, ...extra }, SESSION_KEY, { raw }),
        ).rejects.toThrow();
      }
    }
    for (const extra of [
      { requestId: undefined },
      { expectedHeadCommit: undefined },
      { requestId: randomUUID() },
    ]) {
      await expect(f.invoke("guest", { ...args, ...extra })).rejects.toThrow();
    }
    f.state.head.sha = "f".repeat(40);
    await expect(f.invoke("guest", args)).rejects.toThrow("head changed");
    f.state.head.sha = f.publication.headCommit;
    for (const merged of [false, true]) {
      f.state.state = "closed";
      f.state.merged = merged;
      await expect(f.invoke("guest", args)).rejects.toThrow("closed");
    }
    expect(f.writes).toEqual([]);
  });

  it("rejects unbound and foreign publications without borrowing the shared publisher's permissions", async () => {
    const f = await fixture();
    const args = { action: "request_review", ...f.expected };
    const unbound = "agent:main:unbound";
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: unbound },
      {
        sessionId: randomUUID(),
        lifecycleRevision: randomUUID(),
        updatedAt: 1,
        sandbox: "required",
        createdActor: { type: "human", source: "profile", id: f.guestProfile },
      },
    );
    await expect(f.invoke("guest", args, unbound)).rejects.toThrow(
      "no completed shared publication",
    );
    const other = await ensureCanonicalUserProfileForEmail("publication-other-guest@example.test");
    const client = createOperatorWsClient({
      connId: other.id,
      scopes: ["operator.sessions.read", "operator.sessions.write"],
    });
    client.authenticatedUserProfile = {
      profileId: other.id,
      displayName: null,
      avatarRevision: "fixture",
      hasAvatar: false,
      updatedAt: 1,
    };
    prepareGatewayConnectOperatorAccess(client);
    await expect(f.invoke("guest", args, SESSION_KEY, { client })).rejects.toThrow();
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    await upsertSessionEntryCore(scope, { visibility: "shared" });
    await addSessionMember(scope, { identityId: other.id, addedBy: f.guestProfile });
    const admission = await resolveSessionMutationAuthorizationAsync({
      client,
      method: "sessions.github.action",
      requestParams: { sessionKey: SESSION_KEY, ...args },
      context: f.guestSource.context as GatewayRequestContext,
    });
    try {
      expect(admission.error).toBeNull();
      expect(admission.authorization).toBeDefined();
      admission.authorization?.assertCurrent();
    } finally {
      admission.authorization?.release?.();
    }
    await expect(f.invoke("guest", args, SESSION_KEY, { client })).rejects.toThrow(
      "The original GitHub publication requester is no longer authorized.",
    );
    expect(f.writes).toEqual([]);
  });

  it.each(["requester", "publisher"] as const)(
    "rejects a changed %s after the PR read",
    async (changed) => {
      const f = await fixture();
      f.onRead(async () => {
        if (changed === "requester") {
          await f.revoke();
        } else {
          mocks.matchesIdentity.mockReturnValue(false);
        }
      });
      await expect(
        f.invoke("guest", { action: "request_review", ...f.expected }),
      ).rejects.toThrow();
      expect(f.writes).toEqual([]);
    },
  );

  it.each(["lost response", "rejected", "invalid receipt"])(
    "reports an uncertain re-review after %s without retrying the POST",
    async (failure) => {
      const f = await fixture();
      if (failure === "lost response") {
        f.loseResponse();
      } else {
        f.reviewResponse(
          commandResult(
            failure === "rejected" ? '{"message":"Resource not accessible"}' : "{}",
            failure === "rejected" ? 1 : 0,
          ),
        );
      }
      await expect(f.invoke("guest", { action: "request_review", ...f.expected })).rejects.toThrow(
        /may already have been posted.*Read the PR comments.*do not retry blindly/u,
      );
      expect(f.writes).toEqual([
        { action: "request_review", input: { body: "@clawsweeper re-review" } },
      ]);
    },
  );

  it("edits only a guest PR body without publishing dirty workspace files", async () => {
    const f = await fixture();
    const local = f.local!;
    await fs.writeFile(path.join(local.cwd, "artifact.txt"), "unfinished work\n");
    await fs.writeFile(path.join(local.cwd, "untracked.sqlite-wal"), "fixture data\n");
    const before = {
      head: await local.git("rev-parse", "HEAD"),
      index: await local.git("write-tree"),
      diff: await local.git("diff", "--binary"),
      status: await local.git("status", "--porcelain=v1"),
      body: f.state.body,
      title: f.state.title,
    };
    const originalSession = loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY });
    const commandsBefore = mocks.runCommand.mock.calls.length;
    const checkpointsBefore = checkpoint.mock.calls.length;
    await expect(f.invoke("guest", { body: "" })).rejects.toThrow(/invalid.*params/iu);
    expect((await f.invoke("guest", { action: "edit" })).details).toMatchObject({
      body: before.body,
      title: before.title,
      publication: f.publication,
    });
    const body = `Fixes #123\n\n${before.body}`;
    const result = await f.invoke("guest", {
      action: "edit",
      ...f.expected,
      body,
      expectedBody: before.body,
    });
    expect(result.details).toMatchObject({ state: "draft", body, title: before.title });
    expect(f.writes).toEqual([{ action: "edit", input: { body } }]);
    expect(
      mocks.runCommand.mock.calls.slice(commandsBefore).every(([argv]) => argv[0] === "gh"),
    ).toBe(true);
    expect(checkpoint.mock.calls.length).toBe(checkpointsBefore);
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY })).toEqual(
      originalSession,
    );
    expect(await local.git("rev-parse", "HEAD")).toBe(before.head);
    expect(await local.git("write-tree")).toBe(before.index);
    expect(await local.git("diff", "--binary")).toBe(before.diff);
    expect(await local.git("status", "--porcelain=v1")).toBe(before.status);
    expect(await fs.readFile(path.join(local.cwd, "untracked.sqlite-wal"), "utf8")).toBe(
      "fixture data\n",
    );
  });

  it("edits a repository PR title, preserving a human body edit and reconciling a lost response", async () => {
    const f = await fixture("repository");
    const expectedTitle = f.state.title;
    f.state.body = `Human clarification\n\n${f.state.body}`;
    const body = f.state.body;
    const args = { action: "edit", ...f.expected, title: "A clearer title", expectedTitle };
    f.loseResponse();
    expect((await f.invoke("guest", args)).details).toMatchObject({
      title: "A clearer title",
      body,
      state: "draft",
    });
    expect((await f.invoke("guest", args)).details).toMatchObject({
      title: "A clearer title",
      body,
    });
    expect(f.writes).toEqual([{ action: "edit", input: { title: "A clearer title" } }]);
  });

  it("preserves the original attribution after an edit appends another publication footer", async () => {
    const f = await fixture();
    const original = f.state.body;
    const replacement = "\n\n## Worked on by\n\n- @other\n\n<!-- openclaw-publication:fake -->";
    await f.invoke("guest", {
      action: "edit",
      ...f.expected,
      expectedBody: original,
      body: original + replacement,
    });
    await expect(
      f.invoke("guest", {
        action: "edit",
        ...f.expected,
        expectedBody: original + replacement,
        body: "Replacement description" + replacement,
      }),
    ).rejects.toThrow("attribution");
    expect(f.state.body).toBe(original + replacement);
    expect(f.writes).toHaveLength(1);
  });

  it.each(["local", "repository"] as const)(
    "edits the existing %s PR after a later source publication fails",
    async (backend) => {
      const f = await fixture(backend);
      const workflow = "name: Later work\non: push\njobs: {}\n";
      if (f.local) {
        await fs.mkdir(path.join(f.local.cwd, ".github/workflows"), { recursive: true });
        await fs.writeFile(path.join(f.local.cwd, ".github/workflows/later.yml"), workflow);
      } else {
        await f.repository!.capture("new unpublished work\n", "later-failed", {
          ".github/workflows/later.yml": workflow,
        });
      }
      const failed = await f.coordinator.requestForSessionV2(f.request(randomUUID(), f.guest));
      expect(failed).toMatchObject({ status: "failed", code: "github_rejected" });
      expect((await f.invoke("guest", { action: "edit" })).details).toMatchObject({
        publication: f.publication,
      });
      const expectedTitle = f.state.title;
      expect(
        (
          await f.invoke("guest", {
            action: "edit",
            ...f.expected,
            title: "Clarify the existing PR",
            expectedTitle,
          })
        ).details,
      ).toMatchObject({ title: "Clarify the existing PR", publication: f.publication });
      expect(f.writes).toEqual([{ action: "edit", input: { title: "Clarify the existing PR" } }]);
    },
  );

  it("rejects stale metadata, altered attribution, changed publication and closed PR edits", async () => {
    const f = await fixture();
    const body = f.state.body;
    const title = f.state.title;
    const args = {
      action: "edit",
      ...f.expected,
      body: `Description edit\n\n${body}`,
      expectedBody: body,
    };
    f.state.body = `Human clarification\n\n${body}`;
    await expect(f.invoke("guest", args)).rejects.toThrow("metadata changed");
    f.state.body = body;
    f.state.title = "Human title";
    await expect(
      f.invoke("guest", { ...args, title: "Agent title", expectedTitle: title }),
    ).rejects.toThrow("metadata changed");
    for (const changedBody of ["Removed footer", body.replace("- @alice", "- @someone-else")]) {
      expect(changedBody).not.toBe(body);
      await expect(f.invoke("guest", { ...args, body: changedBody })).rejects.toThrow(
        "attribution",
      );
    }
    await expect(f.invoke("guest", { ...args, requestId: randomUUID() })).rejects.toThrow(
      "publication changed",
    );
    await expect(
      f.invoke("guest", { ...args, expectedHeadCommit: "f".repeat(40) }),
    ).rejects.toThrow("publication changed");
    await expect(f.invoke("guest", { ...args, expectedBody: undefined })).rejects.toThrow(
      "expectedBody",
    );
    await expect(
      f.invoke("guest", { ...args, publishingSessionKey: "agent:main:other" }),
    ).rejects.toThrow("current session");
    f.state.state = "closed";
    await expect(f.invoke("guest", args)).rejects.toThrow("closed");
    expect(f.writes).toEqual([]);
    expect(f.state.body).toBe(body);
    expect(f.state.title).toBe("Human title");
  });

  it("rejects an edit after the admitted guest loses authority during the GitHub read", async () => {
    const f = await fixture();
    f.onRead(async () => await f.revoke());
    await expect(
      f.invoke("guest", {
        action: "edit",
        ...f.expected,
        title: "New title",
        expectedTitle: f.state.title,
      }),
    ).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });

  it("rejects guest readiness for another publishing target, foreign work or an unbound workspace", async () => {
    const f = await fixture();
    const args = { action: "ready", ...f.expected };
    await expect(f.invoke("guest", { ...args, publishingSessionKey: SESSION_KEY })).rejects.toThrow(
      /scope|permission/iu,
    );
    const foreign = { agentId: "main", sessionKey: "agent:main:foreign-publication" };
    await upsertSessionEntryCore(foreign, {
      sessionId: randomUUID(),
      updatedAt: 1,
      createdActor: { type: "human", source: "profile", id: f.maintainerProfile },
    });
    await expect(f.invoke("guest", args, foreign.sessionKey)).rejects.toThrow(
      "session is shared for this connection",
    );
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SESSION_KEY },
      { worktree: undefined },
    );
    await expect(f.invoke("guest", args)).rejects.toThrow("no completed shared publication");
    expect(f.writes).toEqual([]);
  });

  it("denies readiness to a shared-session participant who did not create its published draft", async () => {
    const f = await fixture();
    const participant = await ensureCanonicalUserProfileForEmail("publication-peer@example.test");
    const client = createOperatorWsClient({ connId: participant.id, scopes: [...guestScopes] });
    client.authenticatedUserProfile = {
      profileId: participant.id,
      displayName: null,
      avatarRevision: "fixture",
      hasAvatar: false,
      updatedAt: 1,
    };
    prepareGatewayConnectOperatorAccess(client);
    const scope = { agentId: "main", sessionKey: SESSION_KEY };
    await upsertSessionEntryCore(scope, { visibility: "shared" });
    await addSessionMember(scope, { identityId: participant.id, addedBy: f.guestProfile });
    const admission = await resolveSessionMutationAuthorizationAsync({
      client,
      context: Object.assign(createRequestContext(), f.guestSource.context),
      method: "sessions.patch",
      requestParams: { key: SESSION_KEY, label: "Shared work" },
    });
    try {
      expect(admission.error).toBeNull();
      expect(admission.authorization).toBeDefined();
      admission.authorization!.assertCurrent();
      await expect(
        f.invoke("guest", { action: "ready", ...f.expected }, SESSION_KEY, { client }),
      ).rejects.toThrow("The original GitHub publication requester is no longer authorized.");
      expect(f.writes).toEqual([]);
      expect(f.state.draft).toBe(true);
    } finally {
      admission.authorization?.release?.();
    }
  });

  it("rejects guest readiness when authority or publisher identity changes during the read", async () => {
    const f = await fixture();
    f.onRead(async () => {
      mocks.matchesIdentity.mockReturnValue(false);
    });
    await expect(f.invoke("guest", { action: "ready", ...f.expected })).rejects.toThrow(
      "publisher changed",
    );
    mocks.matchesIdentity.mockReturnValue(true);
    f.onRead(async () => await f.revoke());
    await expect(f.invoke("guest", { action: "ready", ...f.expected })).rejects.toThrow();
    expect(f.writes).toEqual([]);
  });

  it("reports a rejected edit without a write retry or a publication fallback", async () => {
    const f = await fixture();
    f.rejectEdit();
    await expect(
      f.invoke("guest", {
        action: "edit",
        ...f.expected,
        title: "New title",
        expectedTitle: f.state.title,
      }),
    ).rejects.toThrow(/not confirmed the metadata edit.*Resource not accessible/u);
    expect(f.writes).toEqual([{ action: "edit", input: { title: "New title" } }]);
    expect((await f.invoke("guest", { action: "edit" })).details).toMatchObject({
      title: f.state.title,
      state: "draft",
    });
  });

  it.each(["local", "repository"] as const)(
    "lets a guest ready its own %s draft while only a full-write actor can land it",
    async (backend) => {
      const f = await fixture(backend);
      const actor = backend === "repository" ? "writer" : "admin";
      const scope = { agentId: "main", sessionKey: SESSION_KEY };
      const original = loadSessionEntryReadOnly(scope);
      if (f.local) {
        expect(await f.local.git("rev-list", "--count", "main..HEAD")).toBe("1");
        expect(await f.local.git("log", "-1", "--format=%s")).toBe("Publish session work");
      }
      await f.invoke("guest", {
        action: "edit",
        ...f.expected,
        expectedTitle: "Publish session work",
        title: "fix: preserve descriptive PR titles when landing",
      });
      expect((await f.invoke(actor, { action: "inspect" })).details).toMatchObject({
        state: "draft",
        mergeCommit: null,
        publication: { requestId: f.publication.requestId },
      });
      expect((await f.invoke("guest", { action: "ready", ...f.expected })).details).toMatchObject({
        state: "open",
      });
      if (backend === "repository") {
        f.loseResponse();
      }
      expect(
        (await f.invoke(actor, { action: "merge", ...f.expected, mergeMethod: "squash" })).details,
      ).toMatchObject({ state: "merged", mergeCommit: "e".repeat(40) });
      await f.invoke("admin", { action: "merge", ...f.expected, mergeMethod: "squash" });
      await expect(
        f.invoke("guest", { action: "merge", ...f.expected, mergeMethod: "squash" }),
      ).rejects.toThrow(/scope|permission/iu);
      expect(f.writes.map((write) => write.action)).toEqual(["edit", "ready", "merge"]);
      expect(f.writes[2]?.input).toEqual({
        sha: f.publication.headCommit,
        merge_method: "squash",
        commit_title: "fix: preserve descriptive PR titles when landing",
        commit_message: "Co-authored-by: alice <7+alice@users.noreply.github.com>",
      });
      expect(loadSessionEntryReadOnly(scope)).toEqual(original);
      expect(original).toMatchObject({ sandbox: "required", createdActor: { id: f.guestProfile } });
    },
  );

  it.each(["local", "repository"] as const)(
    "closes a %s PR without merging or changing saved work, including repeated requests",
    async (backend) => {
      const f = await fixture(backend);
      const scope = { agentId: "main", sessionKey: SESSION_KEY };
      const original = loadSessionEntryReadOnly(scope);
      const originalHead = await f.local?.git("rev-parse", "HEAD");
      const originalWorktree = await f.local?.git("status", "--porcelain=v1", "--branch");
      if (backend === "repository") {
        f.state.draft = false;
        f.loseResponse();
      }
      f.state.mergeable = false;
      f.state.mergeable_state = "blocked";
      const args = { action: "close", ...f.expected };
      await expect(f.invoke("guest", args)).rejects.toThrow(/scope|permission/iu);
      expect(f.writes).toEqual([]);
      expect(
        (await f.invoke(backend === "local" ? "admin" : "writer", args)).details,
      ).toMatchObject({
        state: "closed",
        mergeCommit: null,
      });
      expect((await f.invoke("admin", args)).details).toMatchObject({ state: "closed" });
      await expect(f.invoke("guest", args)).rejects.toThrow(/scope|permission/iu);
      expect(f.writes).toEqual([{ action: "close", input: { state: "closed" } }]);
      expect(f.state.merged).toBe(false);
      expect(loadSessionEntryReadOnly(scope)).toEqual(original);
      if (f.local) {
        expect(await f.local.git("rev-parse", "HEAD")).toBe(originalHead);
        expect(await f.local.git("status", "--porcelain=v1", "--branch")).toBe(originalWorktree);
      }
    },
  );

  it("reports a rejected close without claiming success or retrying the write", async () => {
    const f = await fixture();
    f.rejectClose();
    await expect(f.invoke("admin", { action: "close", ...f.expected })).rejects.toThrow(
      /GitHub has not confirmed close.*Resource not accessible/u,
    );
    expect((await f.invoke("admin", { action: "inspect" })).details).toMatchObject({
      state: "draft",
      mergeCommit: null,
    });
    expect(f.writes).toEqual([{ action: "close", input: { state: "closed" } }]);
  });

  it("reports an already-merged PR honestly instead of closing or rewriting it", async () => {
    const f = await fixture();
    f.state.merged = true;
    f.state.state = "closed";
    f.state.merge_commit_sha = "e".repeat(40);
    expect((await f.invoke("admin", { action: "close", ...f.expected })).details).toMatchObject({
      state: "merged",
      mergeCommit: "e".repeat(40),
    });
    expect(f.writes).toEqual([]);
  });

  it.each([
    "changed head",
    "close changed head",
    "different receipt",
    "missing head",
    "closed PR",
    "blocked checks",
  ])("rejects %s before GitHub writes", async (change) => {
    const f = await fixture();
    const args: Record<string, unknown> = { action: "ready", ...f.expected };
    if (change.includes("changed head")) {
      f.state.head.sha = "f".repeat(40);
    }
    if (change === "close changed head" || change === "different receipt") {
      args.action = "close";
    }
    if (change === "different receipt") {
      args.requestId = randomUUID();
    }
    if (change === "missing head") {
      delete args.expectedHeadCommit;
    }
    if (change === "closed PR") {
      f.state.state = "closed";
    }
    if (change === "blocked checks") {
      f.state.draft = false;
      f.state.mergeable_state = "blocked";
      args.action = "merge";
      args.mergeMethod = "merge";
    }
    await expect(f.invoke(args.action === "ready" ? "guest" : "admin", args)).rejects.toThrow(
      /changed|inspect|closed/iu,
    );
    expect(f.writes).toEqual([]);
  });

  it("revalidates the admitted person's role after GitHub state is read", async () => {
    const f = await fixture();
    f.onRead(async () => {
      await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
      invalidateOperatorRolePolicy(f.maintainerProfile);
    });
    await expect(f.invoke("admin", { action: "close", ...f.expected })).rejects.toThrow(
      /role changed/iu,
    );
    expect(f.writes).toEqual([]);
  });

  it("retains the selected publisher when credentials are unavailable", async () => {
    const f = await fixture();
    mocks.prepareIdentity.mockRejectedValue(new Error("Publisher credentials unavailable"));
    await expect(f.invoke("guest", { action: "ready", ...f.expected })).rejects.toThrow(
      "credentials unavailable",
    );
    expect(f.writes).toEqual([]);
  });

  it.each(["merge", "rebase"] as const)(
    "reconciles a lost %s response and repeated ready without another write",
    async (mergeMethod) => {
      const f = await fixture();
      f.loseResponse();
      expect((await f.invoke("guest", { action: "ready", ...f.expected })).details).toMatchObject({
        state: "open",
      });
      await f.invoke("guest", { action: "ready", ...f.expected });
      expect(
        (await f.invoke("admin", { action: "merge", ...f.expected, mergeMethod })).details,
      ).toMatchObject({ state: "merged" });
      expect(f.writes.map((write) => write.action)).toEqual(["ready", "merge"]);
      expect(f.writes[1]?.input).toEqual({
        sha: f.publication.headCommit,
        merge_method: mergeMethod,
      });
    },
  );

  it("reports repository-check rejection without auto-merge or deleting saved work", async () => {
    const f = await fixture();
    f.state.draft = false;
    f.rejectMerge();
    await expect(
      f.invoke("admin", { action: "merge", ...f.expected, mergeMethod: "merge" }),
    ).rejects.toThrow(/required reviews, checks.*gh api exit 1.*Required checks have not passed/u);
    expect(f.state.merged).toBe(false);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.input).toEqual({ sha: f.publication.headCommit, merge_method: "merge" });
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY })?.sandbox).toBe(
      "required",
    );
  });

  it.each(["stderr", "transport", "exit zero", "readback", "changed head"])(
    "reports a bounded, redacted %s failure without retrying",
    async (kind) => {
      const f = await fixture();
      f.state.draft = false;
      const token = `ghp_${"a".repeat(36)}`;
      const detail = `HTTP 403: merge refused. Authorization: Bearer ${token}\n${"x".repeat(3000)}`;
      f.rejectMerge(
        kind === "transport"
          ? new Error(detail)
          : kind === "stderr"
            ? { ...commandResult("", 1), stderr: Buffer.from(detail) }
            : commandResult(detail),
      );
      if (kind === "readback" || kind === "changed head") {
        let reads = 0;
        f.onRead(async () => {
          if (++reads === 2) {
            if (kind === "readback") {
              throw new Error("PR state readback unavailable");
            }
            f.state.head.sha = "f".repeat(40);
          }
        });
      }
      const error = await f
        .invoke("admin", { action: "merge", ...f.expected, mergeMethod: "squash" })
        .catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toContain("HTTP 403: merge refused");
      expect(String(error)).toContain("Command result:");
      expect(String(error)).not.toContain(token);
      expect(String(error).length).toBeLessThan(2300);
      expect(f.writes).toHaveLength(1);
      expect(f.state.merged).toBe(false);
    },
  );

  it("uses an explicitly selected publishing child and rejects an unrelated target", async () => {
    const f = await fixture();
    const parent = "agent:main:dashboard:parent";
    await persistPublicationTestSession(parent);
    const args = { action: "close", ...f.expected, publishingSessionKey: SESSION_KEY };
    await expect(f.invoke("admin", args, parent)).rejects.toThrow("not a child");
    expect(f.writes).toEqual([]);
    await upsertSessionEntryCore(
      { agentId: "main", sessionKey: SESSION_KEY },
      { parentSessionKey: parent },
    );
    expect((await f.invoke("admin", args, parent)).details).toMatchObject({
      state: "closed",
      publishingSessionKey: SESSION_KEY,
    });
    expect(f.writes).toHaveLength(1);
  });
});
