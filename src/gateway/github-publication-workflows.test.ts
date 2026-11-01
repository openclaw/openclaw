// Install transport mocks before the native tool loads publication owners.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  BRANCH,
  commandResult,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, expect, it, onTestFinished, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import * as publicationExecutor from "./github-publication-executor.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  createGitHubPublicationRequesterFixture,
  createRequesterPublicationFixture,
  guestScopes,
} from "./github-publication-requester.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import type { OperatorScope } from "./operator-scopes.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const mocks = githubPublicationTestMocks();
// Inert fixture only. No workflow is sent to GitHub or executed.
const workflow = "name: synthetic\non: workflow_dispatch\njobs: {}\n";
const cases = ["add", "modify", "delete", "mode", "committed"] as const;
const createRequesters = async () => {
  const f = await createRequesterPublicationFixture(vi.fn(), "local", {
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  });
  if (!f.local) {
    throw new Error("Expected a local publication fixture.");
  }
  const { local } = f;
  const publish = (key: string, requester = f.guest) =>
    f.coordinator.requestForSessionV2(f.request(key, requester));
  return { ...f, local: { ...local, file: (name: string) => path.join(local.cwd, name) }, publish };
};
type Workspace = Awaited<ReturnType<typeof createRequesters>>["local"];
type ToolCaller = NonNullable<Parameters<typeof withGatewayToolCallerIdentity>[0]>;
type RequestScope = Parameters<typeof withPluginRuntimeGatewayRequestScope>[0];

function invokeTool<T>(
  context: NonNullable<RequestScope["context"]>,
  client: RequestScope["client"],
  run: () => T,
  caller: Partial<ToolCaller> = {},
) {
  return withPluginRuntimeGatewayRequestScope(
    { context, client, isWebchatConnect: () => false },
    () =>
      withGatewayToolCallerIdentity(
        {
          agentId: "main",
          sessionKey: SESSION_KEY,
          operationalRunInstance: { instanceId: "publication-tool", runId: "publication-run" },
          receiptAuthority: () => caller.operatorAuthority?.assertCurrent(),
          gatewayContextResolver: () => context,
          ...caller,
        },
        run,
      ),
  );
}

async function writeWorkflow(workspace: Workspace, name = "example.yml", present = true) {
  const file = workspace.file(`.github/workflows/${name}`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  if (present) {
    await fs.writeFile(file, workflow);
  }
  return file;
}

async function commitAll(workspace: Workspace, message: string) {
  await workspace.git("add", "-A");
  await workspace.git("commit", "-m", message);
  return workspace.git("rev-parse", "HEAD");
}

function mockTargetHead(
  head: () => string,
  matches = (arg: string) => arg.includes("/git/ref/heads/"),
) {
  const transport = mocks.runCommand.getMockImplementation()!;
  mocks.runCommand.mockImplementation(async (args, options) => {
    if (args[0] === "gh" && args.some(matches)) {
      return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: head() }));
    }
    return await transport(args, options);
  });
}

installGitHubPublicationTestHarness({
  creatorEmail: "publication-guest@example.test",
  sandbox: "required",
  realWorktree: true,
});

it.each([
  ...cases.map((operation) => ({ operation, allowed: false, actor: "operator", route: "rpc" })),
  { operation: "modify", allowed: true, actor: "operator", route: "rpc" },
  { operation: "ordinary", allowed: false, actor: "operator", route: "rpc" },
  { operation: "modify", allowed: false, actor: "system", route: "rpc" },
  { operation: "modify", allowed: true, actor: "system", route: "rpc" },
  { operation: "modify", allowed: true, actor: "operator", route: "tool" },
  { operation: "modify", allowed: false, actor: "operator", route: "tool" },
  { operation: "ordinary", allowed: false, actor: "operator", route: "tool" },
  { operation: "modify", allowed: true, actor: "admin", route: "tool" },
  { operation: "modify", allowed: false, actor: "narrowed", route: "tool" },
  { operation: "modify", allowed: true, actor: "system", route: "tool" },
  { operation: "modify", allowed: false, actor: "system", route: "tool" },
  { operation: "modify", allowed: false, actor: "unscoped-system", route: "tool" },
  { operation: "modify", allowed: true, actor: "admin", route: "gateway" },
  { operation: "modify", allowed: false, actor: "admin", route: "gateway-session" },
  { operation: "modify", allowed: false, actor: "admin", route: "gateway-empty" },
  { operation: "modify", allowed: false, actor: "system", route: "gateway-write" },
  { operation: "modify", allowed: true, actor: "system", route: "gateway-write" },
  { operation: "modify", allowed: false, actor: "system-missing-scopes", route: "gateway-write" },
] as const)(
  "checks $operation for $actor with full workflow authority=$allowed through $route",
  async ({ operation, allowed, actor, route }) => {
    const f = await createRequesters();
    const workspace = f.local;
    const workflowPath = await writeWorkflow(
      workspace,
      "example.yml",
      ["modify", "delete", "mode", "ordinary"].includes(operation),
    );
    const baseHead = await commitAll(workspace, "synthetic publication baseline");
    mockTargetHead(
      () => baseHead,
      (arg) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"),
    );
    if (operation === "mode") {
      await fs.chmod(workflowPath, 0o755);
      await workspace.git("update-index", "--chmod=+x", ".github/workflows/example.yml");
    } else if (operation === "delete") {
      await fs.unlink(workflowPath);
    } else if (operation !== "ordinary") {
      await fs.writeFile(workflowPath, `${workflow}# accepted change\n`);
    }
    if (operation === "committed") {
      await commitAll(workspace, "synthetic source commit");
    }
    await fs.writeFile(workspace.file("artifact.txt"), "ordinary accepted work\n");
    const head = await workspace.git("rev-parse", "HEAD");
    const index = await fs.readFile(workspace.file(".git/index"));
    const before = await workspace.git("diff", "HEAD");

    const system =
      actor === "system" || actor === "unscoped-system" || actor === "system-missing-scopes";
    const nativeFullSource =
      route !== "rpc" && !system && (allowed || actor === "admin" || actor === "narrowed");
    if (nativeFullSource) {
      await setCanonicalUserProfileRole(f.guestProfile, "maintainer");
      invalidateOperatorRolePolicy(f.guestProfile);
    }
    const source = nativeFullSource
      ? await createGitHubPublicationRequesterFixture({
          profileId: f.guestProfile,
          scopes:
            actor === "admin" || actor === "narrowed" ? ["operator.admin"] : ["operator.write"],
          agentId: "main",
          sessionKey: SESSION_KEY,
        })
      : allowed
        ? f.maintainerSource
        : f.guestSource;
    const client = system
      ? createSyntheticPluginRuntimeClient({
          operatorRoleActor: { kind: "system" },
          scopes: allowed ? ["operator.write"] : guestScopes,
        })
      : source.client;
    if (actor === "system-missing-scopes") {
      delete client.connect.scopes;
    }
    const context = {
      ...createContext(),
      ...source.context,
      githubPublicationService: f.coordinator,
    };
    let result: unknown;
    if (route !== "rpc") {
      const original = await captureGatewayOperatorRunAuthority({ client, context });
      if (!system) {
        assert(original, "Expected original operator authority");
      }
      if (original) {
        onTestFinished(original.release);
      }
      const accepted = vi.spyOn(f.coordinator, "requestForSessionV2");
      const scopedClient =
        actor === "unscoped-system"
          ? undefined
          : actor === "narrowed"
            ? { ...client, connect: { ...client.connect, scopes: guestScopes } }
            : client;
      const scopes: OperatorScope[] =
        route === "gateway-empty"
          ? []
          : route === "gateway-write"
            ? ["operator.write"]
            : ["operator.sessions.write"];
      const pending = invokeTool(
        context,
        scopedClient,
        async () =>
          route === "tool"
            ? (await createGitHubPublishTool().execute(operation, {})).details
            : await callGatewayTool(
                "sessions.github.publish",
                {},
                { sessionKey: SESSION_KEY, idempotencyKey: operation },
                route === "gateway" ? undefined : { scopes },
              ),
        original ? { operatorAuthority: original.authority } : {},
      );
      if (route === "gateway-empty" || (route === "gateway-write" && !allowed)) {
        await expect(pending).rejects.toThrow("missing scope: operator.sessions.write");
        expect(accepted).not.toHaveBeenCalled();
        expect(workspace.effects).toEqual([]);
        return;
      }
      result = await pending;
      expect(accepted.mock.lastCall?.[0].requester?.snapshot.actor).toEqual(
        system ? { kind: "system" } : { kind: "operator", profileId: f.guestProfile },
      );
    } else {
      const respond = vi.fn();
      const params = { sessionKey: SESSION_KEY, idempotencyKey: operation };
      await handleGatewayRequest({
        req: { type: "req", id: operation, method: "sessions.github.publish", params },
        context,
        client,
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond).toHaveBeenCalledWith(true, expect.anything());
      result = respond.mock.calls[0]?.[1];
    }
    if (allowed || operation === "ordinary") {
      expect(result, JSON.stringify(result)).toMatchObject({ status: "published" });
      expect(workspace.effects).toEqual(["push", "pull_request"]);
    } else {
      expect(result).toMatchObject({
        status: "failed",
        code: "github_rejected",
        nextAction: expect.stringMatching(/OpenClaw.*not a GitHub token scope/),
      });
      expect(workspace.effects).toEqual([]);
      expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
      expect(await fs.readFile(workspace.file(".git/index"))).toEqual(index);
      expect(await workspace.git("diff", "HEAD")).toBe(before);
      expect(await fs.readFile(workspace.file("artifact.txt"), "utf8")).toBe(
        "ordinary accepted work\n",
      );
    }
  },
);

it.each(["first", "checkpoint", "merge"])(
  "publishes target-main workflows through a restricted scheduled tool (%s)",
  async (kind) => {
    const f = await createRequesters();
    const workspace = f.local;
    const directory = workspace.file(".github/workflows");
    await fs.mkdir(directory, { recursive: true });
    for (const name of ["upstream.yml", "removed.yaml", "renamed.yml", "mode.yml"]) {
      await fs.writeFile(path.join(directory, name), workflow);
    }
    let targetHead = await commitAll(workspace, "common workflow baseline");
    await workspace.git("update-ref", "refs/heads/main", targetHead);
    mockTargetHead(() => targetHead);
    if (kind !== "first") {
      await fs.writeFile(workspace.file("artifact.txt"), "first source change\n");
      expect(await f.publish("first-source")).toMatchObject({ status: "published" });
    }
    const publishedHead = await workspace.git("rev-parse", "HEAD");
    await workspace.git("checkout", "main");
    await fs.writeFile(path.join(directory, "upstream.yml"), workflow + "# target main update\n");
    await fs.unlink(path.join(directory, "removed.yaml"));
    await fs.rename(path.join(directory, "renamed.yml"), path.join(directory, "new-name.yml"));
    await fs.chmod(path.join(directory, "mode.yml"), 0o755);
    await fs.writeFile(path.join(directory, "added.yaml"), workflow);
    await workspace.git("add", "-A");
    await workspace.git("update-index", "--chmod=+x", ".github/workflows/mode.yml");
    await workspace.git("commit", "-m", "upstream workflow update");
    targetHead = await workspace.git("rev-parse", "HEAD");
    await workspace.git("checkout", BRANCH);
    if (kind === "merge") {
      await workspace.git("merge", "--no-edit", "main");
    } else {
      await workspace.git(
        "restore",
        "--source",
        targetHead,
        "--staged",
        "--worktree",
        "--",
        ".github/workflows",
      );
    }
    await fs.writeFile(workspace.file("artifact.txt"), "source after upstream\n");
    expect(await workspace.git("diff", targetHead, "--", ".github/workflows")).toBe("");
    expect(await workspace.git("diff", publishedHead, "--", ".github/workflows")).not.toBe("");
    const client = createSyntheticPluginRuntimeClient({
      operatorRoleActor: { kind: "system" },
      scopes: guestScopes,
    });
    const context = {
      ...createContext(),
      ...f.guestSource.context,
      githubPublicationService: f.coordinator,
    };
    const accepted = vi.spyOn(f.coordinator, "requestForSessionV2");
    const result = await invokeTool(
      context,
      client,
      async () => (await createGitHubPublishTool().execute("upstream-merge", {})).details,
      { operationalRunInstance: { instanceId: "scheduled-workflow", runId: "scheduled-run" } },
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: "published" });
    expect(accepted.mock.lastCall?.[0].requester?.snapshot).toMatchObject({
      actor: { kind: "system" },
      scopes: ["operator.sessions.write"],
    });
    expect(workspace.effects.filter((effect) => effect === "push")).toHaveLength(
      kind === "first" ? 1 : 2,
    );
  },
);

it("rejects target inheritance with multiple best common ancestors", async () => {
  const f = await createRequesters();
  const workspace = f.local;
  const base = await commitAll(workspace, "source baseline");
  const baseTree = await workspace.git("rev-parse", "HEAD^{tree}");
  await writeWorkflow(workspace);
  await workspace.git("add", "-A");
  const workflowTree = await workspace.git("write-tree");
  const commit = (tree: string, message: string, ...parents: string[]) =>
    workspace.git(
      "commit-tree",
      tree,
      ...parents.flatMap((parent) => ["-p", parent]),
      "-m",
      message,
    );
  const left = await commit(baseTree, "left", base);
  const right = await commit(workflowTree, "right", base);
  const source = await commit(baseTree, "source merge", left, right);
  const target = await commit(workflowTree, "target merge", right, left);
  await workspace.git("reset", "--hard", source);
  let targetHead = base;
  mockTargetHead(() => targetHead);
  await fs.writeFile(workspace.file("artifact.txt"), "ordinary source\n");
  expect(await f.publish("first")).toMatchObject({
    status: "published",
  });
  const published = await workspace.git("rev-parse", "HEAD");
  targetHead = target;
  expect((await workspace.git("merge-base", "--all", published, target)).split("\n")).toHaveLength(
    2,
  );
  await writeWorkflow(workspace);
  await workspace.git("add", "-A");
  const acceptedTree = await workspace.git("write-tree");
  const merged = await commit(acceptedTree, "accepted merge", published, target);
  await workspace.git("reset", "--hard", merged);
  expect(await f.publish("ambiguous")).toMatchObject({
    status: "failed",
    code: "github_rejected",
    nextAction: expect.stringContaining("Ask a maintainer"),
  });
  expect(await workspace.git("rev-parse", "HEAD")).toBe(merged);
  expect(workspace.effects.filter((effect) => effect === "push")).toHaveLength(1);
});

it("checks the accepted tree while leaving later workflow edits unpublished", async () => {
  const f = await createRequesters();
  const workspace = f.local;
  const file = workspace.file(".github/workflows/later.yml");
  const resolveRepository = mocks.resolveRepository.getMockImplementation()!;
  mocks.resolveRepository.mockImplementationOnce(async () => {
    await writeWorkflow(workspace, "later.yml");
    return await resolveRepository();
  });
  expect(await f.publish("immutable-workflows")).toMatchObject({ status: "published" });
  expect(await workspace.git("ls-tree", "HEAD", ".github/workflows")).toBe("");
  expect(await fs.readFile(file, "utf8")).toBe(workflow);
  expect(workspace.effects).toEqual(["push", "pull_request"]);
});

it.each(["before local CAS", "before push"] as const)(
  "settles the accepted index when workflow permission closes %s",
  async (boundary) => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = await writeWorkflow(workspace);
    const head = await workspace.git("rev-parse", "HEAD");
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (
        boundary === "before push"
          ? args.includes("update-ref")
          : args.includes("write-tree") && options?.env?.GIT_INDEX_FILE?.endsWith("observed-index")
      ) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    await expect(f.publish(boundary, f.maintainer)).resolves.toMatchObject({
      status: "failed",
      code: "identity_changed",
    });
    expect(workspace.effects).toEqual([]);
    if (boundary === "before push") {
      expect(await workspace.git("show", "HEAD:.github/workflows/example.yml")).toBe(
        workflow.trim(),
      );
      expect(await workspace.git("diff", "--cached", "HEAD")).toBe("");
    } else {
      expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
      await expect(fs.stat(workspace.file(".git/index.lock"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        (await fs.readdir(workspace.file(".git"))).some((entry) =>
          entry.startsWith("index.openclaw-"),
        ),
      ).toBe(false);
    }
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
  },
);

it("rechecks the publisher after workflow authorization at the push boundary", async () => {
  const f = await createRequesters();
  await writeWorkflow(f.local);
  const execute = publicationExecutor.executeGitHubPublication;
  let pushRecorded = false;
  let publisherRevoked = false;
  const intercepted = vi
    .spyOn(publicationExecutor, "executeGitHubPublication")
    .mockImplementation((params) =>
      execute({
        ...params,
        recordEffect: async (effect, observed) => {
          await params.recordEffect?.(effect, observed);
          if (effect === "push" && observed === undefined) {
            pushRecorded = true;
          }
        },
        assertWorkflowChangesAllowed: () => {
          params.assertWorkflowChangesAllowed();
          if (pushRecorded) {
            publisherRevoked = true;
            mocks.matchesIdentity.mockReturnValue(false);
          }
        },
      }),
    );
  onTestFinished(() => intercepted.mockRestore());

  await expect(f.publish("publisher-at-push", f.maintainer)).rejects.toThrow(
    GitHubPublicationRecoveryPendingError,
  );
  expect(publisherRevoked).toBe(true);
  expect(f.maintainer.assertCurrent).not.toThrow();
  expect(f.local.effects).toEqual([]);
  expect(f.externalWrites).toEqual([]);
});

it("cannot reintroduce a workflow after a remote reset following the last observation", async () => {
  const f = await createRequesters();
  const workspace = f.local;
  const original = await workspace.git("rev-parse", "HEAD");
  await writeWorkflow(workspace);
  const published = await commitAll(workspace, "maintainer workflow");
  const remote = path.join(root, "race-remote.git");
  await workspace.git("init", "--bare", remote);
  await workspace.git("push", remote, `${published}:refs/heads/${BRANCH}`);
  await fs.writeFile(workspace.file("artifact.txt"), "guest change\n");
  const transport = mocks.runCommand.getMockImplementation()!;
  let pushes = 0;
  mocks.runCommand.mockImplementation(async (args, options) => {
    if (args.includes("ls-remote")) {
      return commandResult(
        await workspace.git("ls-remote", "--refs", remote, `refs/heads/${BRANCH}`),
      );
    }
    if (args.includes("push")) {
      pushes += 1;
      await workspace.git("--git-dir", remote, "update-ref", `refs/heads/${BRANCH}`, original);
      const remoteIndex = args.indexOf("--") + 1;
      try {
        return commandResult(
          await workspace.git(
            ...args
              .slice(1)
              .map((arg: string, index: number) => (index + 1 === remoteIndex ? remote : arg)),
          ),
        );
      } catch {
        return commandResult("", 1);
      }
    }
    return await transport(args, options);
  });
  const request = f.request("reset-after-observation", f.guest);
  await expect(f.coordinator.requestForSessionV2(request)).rejects.toThrow(
    GitHubPublicationRecoveryPendingError,
  );
  expect(await f.coordinator.requestForSessionV2(request)).toMatchObject({
    status: "failed",
    code: "github_rejected",
  });
  expect(pushes).toBe(1);
  expect(await workspace.git("--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(
    original,
  );
  expect(workspace.effects).toEqual([]);
  expect(await fs.readFile(workspace.file("artifact.txt"), "utf8")).toBe("guest change\n");
});
