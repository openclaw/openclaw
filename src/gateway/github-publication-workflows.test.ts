// Install transport mocks before the native tool loads publication owners.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  BRANCH,
  commandResult,
  createGitHubPublicationRequesterFixture,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
  root,
} from "./github-publication.test-support.js";
import fs from "node:fs/promises";
import path from "node:path";
import { assert, describe, expect, it, onTestFinished, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { callGatewayTool } from "../agents/tools/gateway.js";
import { createGitHubPublishTool } from "../agents/tools/github-publish-tool.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import { setCanonicalUserProfileRole } from "../state/user-profile-writes.js";
import * as publicationExecutor from "./github-publication-executor.js";
import { GitHubPublicationRecoveryPendingError } from "./github-publication-git-index.js";
import {
  createRequesterPublicationFixture,
  guestScopes,
} from "./github-publication-requester.test-support.js";
import { invalidateOperatorRolePolicy } from "./operator-role-policy.js";
import { captureGatewayOperatorRunAuthority } from "./operator-run-authority.js";
import { handleGatewayRequest } from "./server-methods.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import { createSyntheticPluginRuntimeClient } from "./server-plugin-runtime-client.js";

const mocks = githubPublicationTestMocks();
// Inert fixture only. No workflow is sent to GitHub or executed.
const workflow = "name: synthetic\non: workflow_dispatch\njobs: {}\n";
const cases = ["add", "modify", "delete", "rename-in", "rename-out", "committed"] as const;
const createRequesters = async () => {
  const f = await createRequesterPublicationFixture(vi.fn(), "local", {
    sessionId: SESSION_ID,
    sessionKey: SESSION_KEY,
  });
  if (!f.local) {
    throw new Error("Expected a local publication fixture.");
  }
  return { ...f, local: f.local };
};

describe("accepted GitHub workflow publication", () => {
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
      const workflowPath = path.join(workspace.cwd, ".github/workflows/example.yml");
      const ordinaryPath = path.join(workspace.cwd, "workflow-example.txt");
      await fs.mkdir(path.dirname(workflowPath), { recursive: true });
      if (["modify", "delete", "rename-out", "ordinary"].includes(operation)) {
        await fs.writeFile(workflowPath, workflow);
      }
      if (operation === "rename-in") {
        await fs.writeFile(ordinaryPath, workflow);
      }
      await workspace.git("add", "-A");
      await workspace.git("commit", "-m", "synthetic publication baseline");
      const baseHead = await workspace.git("rev-parse", "HEAD");
      const transport = mocks.runCommand.getMockImplementation()!;
      mocks.runCommand.mockImplementation(async (argv, options) => {
        if (
          argv[0] === "gh" &&
          argv.some((arg: string) => arg.startsWith("repos/openclaw/openclaw/git/ref/heads/"))
        ) {
          return commandResult(JSON.stringify({ ref: "refs/heads/main", sha: baseHead }));
        }
        return await transport(argv, options);
      });
      if (operation === "delete") {
        await fs.unlink(workflowPath);
      } else if (operation === "rename-in") {
        await fs.rename(ordinaryPath, workflowPath);
      } else if (operation === "rename-out") {
        await fs.rename(workflowPath, ordinaryPath);
      } else if (operation !== "ordinary") {
        await fs.writeFile(workflowPath, `${workflow}# accepted change\n`);
      }
      if (operation === "committed") {
        await workspace.git("add", "-A");
        await workspace.git("commit", "-m", "synthetic source commit");
      }
      await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "ordinary accepted work\n");
      const head = await workspace.git("rev-parse", "HEAD");
      const index = await fs.readFile(path.join(workspace.cwd, ".git/index"));
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
        const original = captureGatewayOperatorRunAuthority({ client, context });
        if (!system) {
          assert(original, "Expected original operator authority");
        }
        if (original) {
          onTestFinished(original.release);
        }
        const accepted = vi.spyOn(f.coordinator, "requestForSession");
        const pending = withPluginRuntimeGatewayRequestScope(
          {
            context,
            client:
              actor === "unscoped-system"
                ? undefined
                : actor === "narrowed"
                  ? { ...client, connect: { ...client.connect, scopes: guestScopes } }
                  : client,
            isWebchatConnect: () => false,
          },
          () =>
            withGatewayToolCallerIdentity(
              {
                agentId: "main",
                sessionKey: SESSION_KEY,
                ...(original ? { operatorAuthority: original.authority } : {}),
                operationalRunInstance: {
                  instanceId: "publication-tool",
                  runId: "publication-run",
                },
                receiptAuthority: () => original?.authority.assertCurrent(),
                gatewayContextResolver: () => context,
              },
              async () =>
                route === "tool"
                  ? (await createGitHubPublishTool().execute(operation, {})).details
                  : await callGatewayTool(
                      "sessions.github.publish",
                      {},
                      { sessionKey: SESSION_KEY, idempotencyKey: operation },
                      route === "gateway"
                        ? undefined
                        : {
                            scopes:
                              route === "gateway-empty"
                                ? []
                                : route === "gateway-write"
                                  ? ["operator.write"]
                                  : ["operator.sessions.write"],
                          },
                    ),
            ),
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
          nextAction: expect.stringContaining("Ask a maintainer"),
        });
        expect(workspace.effects).toEqual([]);
        expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
        expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
        expect(await workspace.git("diff", "HEAD")).toBe(before);
        expect(await fs.readFile(path.join(workspace.cwd, "artifact.txt"), "utf8")).toBe(
          "ordinary accepted work\n",
        );
      }
    },
  );

  it("checks the accepted tree while leaving later workflow edits unpublished", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/later.yml");
    const resolveRepository = mocks.resolveRepository.getMockImplementation()!;
    mocks.resolveRepository.mockImplementationOnce(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, workflow);
      return await resolveRepository();
    });
    expect(
      await f.coordinator.requestForSession(f.request("immutable-workflows", f.guest)),
    ).toMatchObject({ status: "published" });
    expect(await workspace.git("ls-tree", "HEAD", ".github/workflows")).toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
    expect(workspace.effects).toEqual(["push", "pull_request"]);
  });

  it("rechecks workflow permission before push while settling an accepted local commit", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.includes("update-ref")) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    expect(
      await f.coordinator.requestForSession(f.request("permission-before-push", f.maintainer)),
    ).toMatchObject({ status: "failed", code: "identity_changed" });
    expect(workspace.effects).toEqual([]);
    expect(await workspace.git("show", "HEAD:.github/workflows/example.yml")).toBe(workflow.trim());
    expect(await workspace.git("diff", "--cached", "HEAD")).toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
  });

  it("cleans an index reservation when workflow permission closes before local CAS", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const head = await workspace.git("rev-parse", "HEAD");
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.includes("write-tree") && options?.env?.GIT_INDEX_FILE?.endsWith("observed-index")) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    await expect(
      f.coordinator.requestForSession(f.request("permission-before-cas", f.maintainer)),
    ).resolves.toMatchObject({ status: "failed", code: "identity_changed" });
    expect(workspace.effects).toEqual([]);
    expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
    await expect(fs.stat(path.join(workspace.cwd, ".git/index.lock"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      (await fs.readdir(path.join(workspace.cwd, ".git"))).some((entry) =>
        entry.startsWith("index.openclaw-"),
      ),
    ).toBe(false);
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
  });

  it("rechecks the publisher after workflow authorization at the push boundary", async () => {
    const f = await createRequesters();
    const file = path.join(f.local.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const execute = publicationExecutor.executeGitHubPublication;
    let pushRecorded = false;
    let publisherRevoked = false;
    const intercepted = vi
      .spyOn(publicationExecutor, "executeGitHubPublication")
      .mockImplementation((params) =>
        execute({
          ...params,
          recordEffect: (effect, observed) => {
            params.recordEffect?.(effect, observed);
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

    await expect(
      f.coordinator.requestForSession(f.request("publisher-at-push", f.maintainer)),
    ).rejects.toThrow(GitHubPublicationRecoveryPendingError);
    expect(publisherRevoked).toBe(true);
    expect(f.maintainer.assertCurrent).not.toThrow();
    expect(f.local.effects).toEqual([]);
    expect(f.externalWrites).toEqual([]);
  });

  it("cannot reintroduce a workflow after a remote reset following the last observation", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const original = await workspace.git("rev-parse", "HEAD");
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    await workspace.git("add", "-A");
    await workspace.git("commit", "-m", "maintainer workflow");
    const published = await workspace.git("rev-parse", "HEAD");
    const remote = path.join(root, "race-remote.git");
    await workspace.git("init", "--bare", remote);
    await workspace.git("push", remote, `${published}:refs/heads/${BRANCH}`);
    await fs.writeFile(path.join(workspace.cwd, "artifact.txt"), "guest change\n");
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
    await expect(f.coordinator.requestForSession(request)).rejects.toThrow(
      GitHubPublicationRecoveryPendingError,
    );
    expect(await f.coordinator.requestForSession(request)).toMatchObject({
      status: "failed",
      code: "github_rejected",
    });
    expect(pushes).toBe(1);
    expect(await workspace.git("--git-dir", remote, "rev-parse", `refs/heads/${BRANCH}`)).toBe(
      original,
    );
    expect(workspace.effects).toEqual([]);
    expect(await fs.readFile(path.join(workspace.cwd, "artifact.txt"), "utf8")).toBe(
      "guest change\n",
    );
  });
});
