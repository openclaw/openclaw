// Install the existing synthetic GitHub transport before loading publication owners.
// oxfmt-ignore
import {
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  persistPublicationTestSession,
  SESSION_ID,
  SESSION_KEY,
} from "./github-publication.test-support.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { SessionGitHubPublicationPublished } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import type { InProcessGatewayCaller } from "../agents/tools/in-process-gateway.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import {
  createGitHubPublicationRequesterFixture,
  createRequesterPublicationFixture,
} from "./github-publication-requester.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { handleGatewayRequest } from "./server-methods.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

const mocks = githubPublicationTestMocks();
const checkpoint = vi.hoisted(() => vi.fn());
vi.mock("./worker-environments/session-repository-checkpoints.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("./worker-environments/session-repository-checkpoints.js")
    >();
  return {
    ...actual,
    withSessionRepositoryCheckpoint: (...args: unknown[]) => checkpoint(...args),
  };
});

async function fixture(backend: "local" | "repository" = "local") {
  const f = await createRequesterPublicationFixture(checkpoint, backend, {
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  });
  const published = await f.coordinator.requestForSessionV2(f.request(randomUUID(), f.guest));
  expect(published.status).toBe("published");
  if (published.status !== "published") {
    throw new Error("Publication fixture did not publish");
  }
  const publication: SessionGitHubPublicationPublished = published;
  const writerSource =
    backend === "repository"
      ? await createGitHubPublicationRequesterFixture({
          profileId: f.maintainerProfile,
          scopes: ["operator.write"],
          sessionKey: SESSION_KEY,
          agentId: "main",
        })
      : f.maintainerSource;
  const state = {
    node_id: "PR_fixture",
    title: "Preserve the guest's work",
    html_url: publication.url,
    state: "open",
    draft: true,
    merged: false,
    head: { ref: publication.branch, sha: publication.headCommit },
    base: { repo: { full_name: publication.repository } },
    mergeable: true,
    mergeable_state: "clean",
    merge_commit_sha: "d".repeat(40),
  };
  const writes: { action: string; input: Record<string, unknown> }[] = [];
  let beforeRead: (() => Promise<void>) | undefined;
  let rejectMerge = false;
  let rejectClose = false;
  let loseResponse = false;
  const previous = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
    if (argv[0] !== "gh" || !argv.includes("--method")) {
      return await previous(argv, options);
    }
    if (argv.includes("GET") && argv.some((arg) => /\/pulls\/\d+$/u.test(arg))) {
      await beforeRead?.();
      return commandResult(JSON.stringify(state));
    }
    if (argv.includes("graphql")) {
      writes.push({ action: "ready", input: JSON.parse(options!.input!) });
      state.draft = false;
    } else if (argv.some((arg) => arg.endsWith("/merge"))) {
      writes.push({ action: "merge", input: JSON.parse(options!.input!) });
      if (rejectMerge) {
        return commandResult('{"message":"Required checks have not passed"}', 1);
      }
      state.merged = true;
      state.state = "closed";
      state.merge_commit_sha = "e".repeat(40);
    } else if (argv.includes("PATCH") && argv.some((arg) => /\/pulls\/\d+$/u.test(arg))) {
      writes.push({ action: "close", input: JSON.parse(options!.input!) });
      if (rejectClose) {
        return commandResult('{"message":"Resource not accessible"}', 1);
      }
      state.state = "closed";
    } else {
      return await previous(argv, options);
    }
    if (loseResponse) {
      throw new Error("Connection closed after GitHub accepted the write");
    }
    return commandResult("{}");
  });
  const invoke = async (
    actor: "guest" | "admin" | "writer",
    args: Record<string, unknown>,
    source = SESSION_KEY,
  ) => {
    const principal =
      actor === "guest" ? f.guestSource : actor === "writer" ? writerSource : f.maintainerSource;
    const callGateway: InProcessGatewayCaller = async <T>(
      method: string,
      params: Record<string, unknown>,
    ) => {
      const respond = vi.fn();
      await handleGatewayRequest({
        req: { type: "req", id: randomUUID(), method, params },
        client: principal.client,
        context: {
          ...principal.context,
          githubPublicationService: f.coordinator,
        } as GatewayRequestContext,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledOnce();
      const [ok, result, error] = respond.mock.calls[0]!;
      if (!ok) {
        throw new Error(error.message);
      }
      return result as T;
    };
    return await withGatewayToolCallerIdentity({ agentId: "main", sessionKey: source }, () =>
      createGitHubPublishTool({ callGateway, actionsAvailable: true }).execute(
        "publication-action",
        args,
      ),
    );
  };
  const expected = { requestId: publication.requestId, expectedHeadCommit: publication.headCommit };
  return {
    ...f,
    publication,
    state,
    writes,
    invoke,
    expected,
    onRead(callback: () => Promise<void>) {
      beforeRead = callback;
    },
    rejectMerge() {
      rejectMerge = true;
    },
    rejectClose() {
      rejectClose = true;
    },
    loseResponse() {
      loseResponse = true;
    },
  };
}

describe("session PR actions through the agent tool and registered Gateway method", () => {
  installGitHubPublicationTestHarness({
    creatorEmail: "publication-guest@example.test",
    sandbox: "required",
    realWorktree: true,
  });

  it.each(["local", "repository"] as const)(
    "lands a %s draft for the current full-write actor without elevating later guest turns",
    async (backend) => {
      const f = await fixture(backend);
      const actor = backend === "repository" ? "writer" : "admin";
      const scope = { agentId: "main", sessionKey: SESSION_KEY };
      const original = loadSessionEntryReadOnly(scope);
      await expect(f.invoke("guest", { action: "ready", ...f.expected })).rejects.toThrow(
        /scope|permission/iu,
      );
      expect(f.writes).toEqual([]);
      expect((await f.invoke(actor, { action: "inspect" })).details).toMatchObject({
        state: "draft",
        mergeCommit: null,
        publication: { requestId: f.publication.requestId },
      });
      expect((await f.invoke(actor, { action: "ready", ...f.expected })).details).toMatchObject({
        state: "open",
      });
      expect(
        (await f.invoke(actor, { action: "merge", ...f.expected, mergeMethod: "squash" })).details,
      ).toMatchObject({ state: "merged", mergeCommit: "e".repeat(40) });
      await f.invoke("admin", { action: "merge", ...f.expected, mergeMethod: "squash" });
      await expect(
        f.invoke("guest", { action: "merge", ...f.expected, mergeMethod: "squash" }),
      ).rejects.toThrow(/scope|permission/iu);
      expect(f.writes.map((write) => write.action)).toEqual(["ready", "merge"]);
      expect(f.writes[1]?.input).toMatchObject({
        sha: f.publication.headCommit,
        merge_method: "squash",
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
      "GitHub has not confirmed close",
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
    await expect(f.invoke("admin", args)).rejects.toThrow(/changed|inspect|closed/iu);
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
    await expect(f.invoke("admin", { action: "ready", ...f.expected })).rejects.toThrow(
      "credentials unavailable",
    );
    expect(f.writes).toEqual([]);
  });

  it("reconciles a lost write response and repeated ready without another write", async () => {
    const f = await fixture();
    f.loseResponse();
    expect((await f.invoke("admin", { action: "ready", ...f.expected })).details).toMatchObject({
      state: "open",
    });
    await f.invoke("admin", { action: "ready", ...f.expected });
    expect(
      (await f.invoke("admin", { action: "merge", ...f.expected, mergeMethod: "merge" })).details,
    ).toMatchObject({ state: "merged" });
    expect(f.writes.map((write) => write.action)).toEqual(["ready", "merge"]);
  });

  it("reports repository-check rejection without auto-merge or deleting saved work", async () => {
    const f = await fixture();
    f.state.draft = false;
    f.rejectMerge();
    await expect(
      f.invoke("admin", { action: "merge", ...f.expected, mergeMethod: "merge" }),
    ).rejects.toThrow("required reviews, checks");
    expect(f.state.merged).toBe(false);
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]?.input).toEqual({ sha: f.publication.headCommit, merge_method: "merge" });
    expect(loadSessionEntryReadOnly({ agentId: "main", sessionKey: SESSION_KEY })?.sandbox).toBe(
      "required",
    );
  });

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
