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
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { SessionGitHubPublicationPublished } from "../../packages/gateway-protocol/src/schema/session-github-publication.js";
import { createSandboxTestContext } from "../agents/sandbox/test-fixtures.js";
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
import { createContext as createRequestContext } from "./server-plugin-in-process-dispatch.test-support.js";
import {
  resolveLocalWorkspaceOwner,
  withLocalWorkspaceProjection,
} from "./worker-environments/local-workspace-projection.js";
import * as workspaceStore from "./worker-environments/local-workspace-store.js";
import { isLocalWorkspaceBaseRefreshRef } from "./worker-environments/workspace-result-inventory.js";
import { workerWorkspaceResultStaging } from "./worker-environments/workspace-result-staging.js";

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

  it("recovers one guest integration, retains saved data and publishes the resolved same draft with base ancestry", async () => {
    const initialWorktree = { ...mocks.findWorktree("session", "unused"), id: randomUUID() };
    mocks.findWorktree.mockImplementation((_kind: string, ownerId: string) => ({
      ...initialWorktree,
      ownerId,
    }));
    const f = await createRequesterPublicationFixture(checkpoint, "local");
    const local = f.local!;
    await fs.writeFile(path.join(local.cwd, ".gitignore"), ".env.local\n.guest-cache\n");
    const first = await f.coordinator.requestForSessionV2(f.request("first-draft", f.guest));
    expect(first.status).toBe("published");
    if (first.status !== "published") {
      throw new Error("Fixture publication failed");
    }
    const created = mocks.runCommand.mock.calls.findLast(
      ([argv]) => argv.includes("POST") && argv.some((arg: string) => arg.endsWith("/pulls")),
    )!;
    const pr = {
      url: first.url,
      userId: 42,
      state: "open",
      body: JSON.parse(created[1].input).body,
      headSha: first.headCommit,
      headRef: first.branch,
      baseRef: "main",
    };
    await local.git("checkout", "main");
    await fs.writeFile(path.join(local.cwd, "artifact.txt"), "upstream change\n");
    await fs.writeFile(path.join(local.cwd, "upstream.txt"), "unrelated upstream file\n");
    await local.git("add", "-A");
    await local.git("commit", "-m", "Advance selected base");
    let baseCommit = await local.git("rev-parse", "HEAD");
    await local.git("checkout", first.branch);
    await fs.writeFile(path.join(local.cwd, ".env.local"), "host-private-fixture");
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (argv: string[], options?: { input?: string }) => {
      if (argv.some((arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))) {
        return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: baseCommit }));
      }
      if (argv.includes("state=all")) {
        return commandResult(JSON.stringify([pr]));
      }
      const result = await transport(argv, options);
      if (argv.includes("push")) {
        pr.headSha = await local.git("rev-parse", "HEAD");
      }
      return result;
    });
    using owner = await resolveLocalWorkspaceOwner({
      ...f.guestSource.session,
      cfg: f.config,
      assertCurrent: f.guest.assertCurrent,
    });
    if (!owner) {
      throw new Error("Fixture managed workspace unavailable");
    }
    const projection = await withLocalWorkspaceProjection(owner, (state) => state.prepare());
    await fs.writeFile(path.join(projection, "artifact.txt"), "guest saved change\n");
    await fs.writeFile(path.join(projection, "guest.txt"), "saved independent work\n");
    await fs.writeFile(path.join(projection, ".guest-cache"), "saved ignored guest work\n");
    await fs.mkdir(path.join(projection, "empty-guest-directory"));
    await fs.appendFile(path.join(projection, ".git/config"), "\n[credential]\nhelper = !false\n");
    const { runCommandBuffered } =
      await vi.importActual<typeof import("../process/exec.js")>("../process/exec.js");
    const sandbox = createSandboxTestContext({
      overrides: {
        sessionKey: f.session.sessionKey,
        workspaceDir: projection,
        containerWorkdir: projection,
        workspaceSource: "managed-worktree",
        backend: {
          id: "docker",
          runtimeId: "fixture",
          runtimeLabel: "fixture",
          workdir: projection,
          buildExecSpec: async () => {
            throw new Error("Fixture does not expose arbitrary exec");
          },
          runShellCommand: async ({ script, args, stdin, signal }) => {
            const result = await runCommandBuffered(
              ["sh", "-c", script, "sandbox-fixture", ...(args ?? [])],
              {
                cwd: projection,
                input: stdin,
                signal,
                timeoutMs: 10_000,
                env: {
                  ...process.env,
                  GH_TOKEN: undefined,
                  GITHUB_TOKEN: undefined,
                  GH_CONFIG_DIR: undefined,
                },
              },
            );
            if (result.code === null) {
              throw new Error("Fixture sandbox command did not exit");
            }
            return { code: result.code, stdout: result.stdout, stderr: result.stderr };
          },
        },
      },
    });
    const guestGit = async (...args: string[]) => {
      const result = await sandbox.backend!.runShellCommand({ script: 'git "$@"', args });
      if (result.code !== 0) {
        throw new Error(result.stderr.toString());
      }
      return result.stdout.toString().trim();
    };
    const guestHead = await guestGit("rev-parse", "HEAD");
    const invoke = async (
      args: Record<string, unknown>,
      prepared: typeof sandbox | null = sandbox,
    ) => {
      const callGateway: InProcessGatewayCaller = async <T>(
        method: string,
        params: Record<string, unknown>,
      ) => {
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { type: "req", id: randomUUID(), method, params },
          client: f.guestSource.client,
          context: Object.assign(createRequestContext(), f.guestSource.context, {
            githubPublicationService: f.coordinator,
            workerSessionPlacementService: f.placements,
          }),
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
      const result = await withGatewayToolCallerIdentity(
        { agentId: "main", sessionKey: f.session.sessionKey },
        () => createGitHubPublishTool({ callGateway, sandbox: prepared }).execute("refresh", args),
      );
      return result.details;
    };
    const beforeAdmission = await local.git("rev-parse", "HEAD");
    await expect(invoke({ action: "refresh_base" }, null)).rejects.toThrow("sandboxed agent");
    await expect(
      invoke({ action: "refresh_base" }, { ...sandbox, workspaceAccess: "ro" }),
    ).rejects.toThrow("read-only");
    expect(await local.git("rev-parse", "HEAD")).toBe(beforeAdmission);
    expect(await fs.readFile(path.join(local.cwd, "artifact.txt"), "utf8")).toBe("accepted\n");
    const stage = workerWorkspaceResultStaging.stageWorkerWorkspaceResult;
    let stagedRefresh = "";
    const stageInterruption = vi
      .spyOn(workerWorkspaceResultStaging, "stageWorkerWorkspaceResult")
      .mockImplementation(async (params) => {
        const result = await stage(params);
        if (isLocalWorkspaceBaseRefreshRef(params.stagedResultRef)) {
          stagedRefresh = params.stagedResultRef;
          throw new Error("interrupted before refresh reservation");
        }
        return result;
      });
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow(
      "interrupted before refresh reservation",
    );
    stageInterruption.mockRestore();
    expect(stagedRefresh).not.toBe("");
    const stagedHead = await local.git("rev-parse", "HEAD");
    const stagedBaseline = await workspaceStore.withLocalWorkspaceStore(
      { worktreeId: owner.worktree.id },
      async (store) => store.get(),
    );
    expect(stagedBaseline?.pending_ref).toBeNull();
    await fs.appendFile(path.join(projection, ".guest-cache"), "saved after interruption\n");
    await fs.mkdir(path.join(projection, "later-empty-guest-directory"));
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    const advancedBaseline = await workspaceStore.withLocalWorkspaceStore(
      { worktreeId: owner.worktree.id },
      async (store) => store.get(),
    );
    expect(advancedBaseline?.baseline_ref).not.toBe(stagedBaseline?.baseline_ref);
    expect(await local.git("rev-parse", "HEAD")).toBe(stagedHead);
    const withStore = workspaceStore.withLocalWorkspaceStore;
    const reservationInterruption = vi
      .spyOn(workspaceStore, "withLocalWorkspaceStore")
      .mockImplementation((params, operation) =>
        withStore(params, (store) =>
          operation({
            ...store,
            update: async (row, patch, authority) => {
              if (
                patch.pending_target === "canonical" &&
                isLocalWorkspaceBaseRefreshRef(patch.pending_ref ?? null)
              ) {
                throw new Error("interrupted before refresh reservation");
              }
              return await store.update(row, patch, authority);
            },
          }),
        ),
      );
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow(
      "interrupted before refresh reservation",
    );
    reservationInterruption.mockRestore();
    expect(await local.git("rev-parse", "MERGE_HEAD")).toBe(baseCommit);
    await fs.writeFile(
      path.join(projection, "artifact.txt"),
      "guest saved change after native preparation\n",
    );
    await withLocalWorkspaceProjection(owner, (state) => state.synchronize("canonical"));
    // Fail after the real canonical receipt, before projection application; retry uses its retained payload.
    let interrupted = false;
    const interruption = vi
      .spyOn(workspaceStore, "withLocalWorkspaceStore")
      .mockImplementation((params, operation) =>
        withStore(params, (store) =>
          operation({
            ...store,
            update: async (row, patch, authority) => {
              const result = await store.update(row, patch, authority);
              if (
                !interrupted &&
                patch.pending_target === "projection" &&
                isLocalWorkspaceBaseRefreshRef(result.pending_ref)
              ) {
                interrupted = true;
                throw new Error("interrupted after canonical acceptance");
              }
              return result;
            },
          }),
        ),
      );
    const interruptionFailure = await invoke({ action: "refresh_base" }).catch(
      (error: unknown) => error,
    );
    expect(interrupted, String(interruptionFailure)).toBe(true);
    expect(interruptionFailure).toBeInstanceOf(Error);
    interruption.mockRestore();
    const pendingRefresh = await withStore({ worktreeId: owner.worktree.id }, async (store) =>
      store.get(),
    );
    expect(pendingRefresh).toMatchObject({ pending_target: "projection", journal_json: null });
    expect(pendingRefresh?.base_commit).not.toBe(baseCommit);
    const refreshed = await invoke({ action: "refresh_base" });
    expect(refreshed).toMatchObject({
      status: "conflicts",
      baseCommit,
      conflictPaths: ["artifact.txt"],
    });
    const conflictedSource = await fs.readFile(path.join(projection, "artifact.txt"), "utf8");
    expect(conflictedSource).toContain("<<<<<<<");
    expect(conflictedSource).toContain("guest saved change after native preparation");
    expect(await fs.readFile(path.join(projection, "upstream.txt"), "utf8")).toBe(
      "unrelated upstream file\n",
    );
    expect(await fs.readFile(path.join(projection, "guest.txt"), "utf8")).toBe(
      "saved independent work\n",
    );
    expect(await fs.readFile(path.join(projection, ".guest-cache"), "utf8")).toBe(
      "saved ignored guest work\nsaved after interruption\n",
    );
    expect((await fs.stat(path.join(projection, "empty-guest-directory"))).isDirectory()).toBe(
      true,
    );
    expect(
      (await fs.stat(path.join(projection, "later-empty-guest-directory"))).isDirectory(),
    ).toBe(true);
    expect(
      await local.git(
        "for-each-ref",
        "--format=%(refname)",
        "refs/openclaw/workspace-base-refresh",
      ),
    ).toBe("");
    await expect(fs.stat(path.join(projection, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await invoke({ action: "refresh_base" })).toMatchObject({
      status: "conflicts",
      baseCommit,
    });
    await expect(
      withLocalWorkspaceProjection(owner, async (state) =>
        state.prepareArchive(await local.git("rev-parse", "HEAD")),
      ),
    ).rejects.toThrow("before archiving");
    await expect(
      f.coordinator.requestForSessionV2(f.request("unresolved", f.guest)),
    ).rejects.toThrow("refresh_base");
    await expect(
      invoke({ action: "refresh_base", conflictsResolved: true, baseCommit: "a".repeat(40) }),
    ).rejects.toThrow("changed");
    await expect(
      invoke({ action: "refresh_base", conflictsResolved: true, baseCommit }),
    ).rejects.toThrow("Conflict markers");
    await fs.writeFile(
      path.join(projection, "artifact.txt"),
      "upstream change\nguest saved change after native preparation\n",
    );
    expect(
      await invoke({ action: "refresh_base", conflictsResolved: true, baseCommit }),
    ).toMatchObject({ status: "refreshed", baseCommit });
    await local.git("merge-base", "--is-ancestor", baseCommit, "HEAD");
    expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
    expect(await guestGit("rev-parse", "refs/openclaw/review-base")).toBe(baseCommit);
    // The canonical helper's local/base target captures this staged diff, not the old guest HEAD.
    const reviewPaths = (await guestGit("diff", "--cached", "--name-only", baseCommit)).split("\n");
    expect(reviewPaths).toContain("artifact.txt");
    expect(reviewPaths).toContain("guest.txt");
    expect(reviewPaths).not.toContain("upstream.txt");
    expect(await guestGit("diff", "--name-only")).toBe("");
    const final = await f.coordinator.requestForSessionV2(f.request("resolved-draft", f.guest));
    expect(final).toMatchObject({ status: "published", url: first.url, branch: first.branch });
    expect(f.publishedTitles).toEqual(["first-draft"]);
    await local.git("merge-base", "--is-ancestor", baseCommit, "HEAD");
    expect(await local.git("show", "HEAD:upstream.txt")).toBe("unrelated upstream file");
    expect(await local.git("show", "HEAD:artifact.txt")).toBe(
      "upstream change\nguest saved change after native preparation",
    );
    expect(await fs.readFile(path.join(local.cwd, ".env.local"), "utf8")).toBe(
      "host-private-fixture",
    );
    await local.git("checkout", "main");
    await fs.writeFile(path.join(local.cwd, "later-upstream.txt"), "later upstream only\n");
    await local.git("add", "later-upstream.txt");
    await local.git("commit", "-m", "Advance base without conflicts");
    baseCommit = await local.git("rev-parse", "HEAD");
    await local.git("checkout", first.branch);
    expect(await invoke({ action: "refresh_base" })).toMatchObject({
      status: "refreshed",
      review: { mode: "local", base: baseCommit },
    });
    expect(await guestGit("rev-parse", "HEAD")).toBe(guestHead);
    expect(
      (await guestGit("diff", "--cached", "--name-only", baseCommit)).split("\n"),
    ).not.toContain("later-upstream.txt");
    expect(await invoke({ action: "refresh_base" })).toMatchObject({
      status: "current",
      review: { mode: "local", base: baseCommit },
    });
    await f.revoke();
    await expect(invoke({ action: "refresh_base" })).rejects.toThrow();
  });
});
