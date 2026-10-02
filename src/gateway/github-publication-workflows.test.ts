// Install transport mocks before the native tool loads publication owners.
// oxfmt-ignore
import {
  SESSION_ID,
  SESSION_KEY,
  commandResult,
  createGitHubPublicationRequesterFixture,
  githubPublicationTestMocks,
  installGitHubPublicationTestHarness,
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
import type { GatewayClient } from "./server-methods/types.js";
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
    { operation: "modify", allowed: false, actor: "system-empty-scopes", route: "tool" },
    { operation: "modify", allowed: false, actor: "unscoped-system", route: "tool" },
    { operation: "modify", allowed: true, actor: "admin", route: "gateway" },
    { operation: "modify", allowed: false, actor: "admin", route: "gateway-session" },
    { operation: "modify", allowed: false, actor: "admin", route: "gateway-empty" },
    { operation: "modify", allowed: false, actor: "system", route: "gateway-write" },
    { operation: "modify", allowed: true, actor: "system", route: "gateway-write" },
    { operation: "modify", allowed: false, actor: "system-missing-scopes", route: "gateway-write" },
  ] as const)(
    "checks $operation for $actor with publication authority=$allowed through $route",
    async ({ operation, allowed, actor, route }) => {
      const f = await createRequesters();
      const workspace = f.local;
      const workflowPath = path.join(workspace.cwd, ".github/workflows/example.yml");
      await fs.mkdir(path.dirname(workflowPath), { recursive: true });
      if (["modify", "delete", "mode", "ordinary"].includes(operation)) {
        await fs.writeFile(workflowPath, workflow);
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
      if (operation === "mode") {
        await fs.chmod(workflowPath, 0o755);
        await workspace.git("update-index", "--chmod=+x", ".github/workflows/example.yml");
      } else if (operation === "delete") {
        await fs.unlink(workflowPath);
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
        actor === "system" ||
        actor === "system-empty-scopes" ||
        actor === "unscoped-system" ||
        actor === "system-missing-scopes";
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
            scopes:
              actor === "system-empty-scopes" ? [] : allowed ? ["operator.write"] : guestScopes,
          })
        : source.client;
      if (actor === "system-missing-scopes") {
        delete client.connect.scopes;
      }
      const context = {
        ...createContext(),
        ...source.context,
        getClientConnIds: (filter?: (candidate: GatewayClient) => boolean) =>
          new Set(client.connId && (!filter || filter(client)) ? [client.connId] : []),
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
                receiptAuthority: () => original?.authority.assertCurrent(),
                gatewayContextResolver: () => context,
              },
              async () => {
                if (route === "tool") {
                  const tool = createGitHubPublishTool();
                  if (!allowed) {
                    return (await tool.execute(operation, {})).details;
                  }
                  const prepared = (
                    await tool.execute(`${operation}-prepare`, { action: "prepare" })
                  ).details as { reviewId: string; digest: string };
                  const review = { reviewId: prepared.reviewId, digest: prepared.digest };
                  let offset: number | null = 0;
                  do {
                    const page = (
                      await tool.execute(`${operation}-diff-${offset}`, {
                        action: "diff",
                        review,
                        offset,
                      })
                    ).details as { nextOffset: number | null };
                    offset = page.nextOffset;
                  } while (offset !== null);
                  return (await tool.execute(operation, { action: "confirm", review })).details;
                }
                const authority: Parameters<typeof callGatewayTool>[3] =
                  route === "gateway"
                    ? undefined
                    : {
                        scopes:
                          route === "gateway-empty"
                            ? []
                            : route === "gateway-write"
                              ? ["operator.write"]
                              : ["operator.sessions.write"],
                      };
                const prepared = allowed
                  ? ((await callGatewayTool(
                      "sessions.github.review",
                      {},
                      {
                        sessionKey: SESSION_KEY,
                        action: "prepare",
                        idempotencyKey: `candidate:${operation}`,
                      },
                      authority,
                    )) as { reviewId: string; digest: string })
                  : undefined;
                return await callGatewayTool(
                  "sessions.github.publish",
                  {},
                  {
                    sessionKey: SESSION_KEY,
                    idempotencyKey: operation,
                    ...(prepared
                      ? { review: { reviewId: prepared.reviewId, digest: prepared.digest } }
                      : {}),
                  },
                  authority,
                );
              },
            ),
        );
        if (!allowed) {
          // An unbound trusted System route has method-minimum scopes, but still
          // needs a reviewed candidate for this restricted session.
          await expect(pending).rejects.toThrow(
            actor === "unscoped-system"
              ? "reviewed publication candidate"
              : "missing scope: operator.write",
          );
          expect(accepted).not.toHaveBeenCalled();
          expect(workspace.effects).toEqual([]);
          expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
          expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
          expect(await workspace.git("diff", "HEAD")).toBe(before);
          return;
        }
        result = await pending;
        expect(accepted.mock.lastCall?.[0].requester?.snapshot.actor).toEqual(
          system ? { kind: "system" } : { kind: "operator", profileId: f.guestProfile },
        );
      } else {
        const respond = vi.fn();
        const params: {
          sessionKey: string;
          idempotencyKey: string;
          review?: { reviewId: string; digest: string };
        } = { sessionKey: SESSION_KEY, idempotencyKey: operation };
        if (allowed) {
          const prepared = vi.fn();
          await handleGatewayRequest({
            req: {
              type: "req",
              id: `prepare:${operation}`,
              method: "sessions.github.review",
              params: { ...params, action: "prepare" },
            },
            context,
            client,
            isWebchatConnect: () => false,
            respond: prepared,
          });
          expect(prepared).toHaveBeenCalledWith(true, expect.objectContaining({ status: "ready" }));
          const candidate = prepared.mock.calls[0]![1];
          params.review = { reviewId: candidate.reviewId, digest: candidate.digest };
        }
        await handleGatewayRequest({
          req: { type: "req", id: operation, method: "sessions.github.publish", params },
          context,
          client,
          isWebchatConnect: () => false,
          respond,
        });
        if (!allowed) {
          expect(respond).toHaveBeenCalledWith(
            false,
            undefined,
            expect.objectContaining({
              code: "FORBIDDEN",
              message: "missing scope: operator.write",
            }),
          );
          expect(workspace.effects).toEqual([]);
          expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
          expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
          expect(await workspace.git("diff", "HEAD")).toBe(before);
          return;
        }
        expect(respond).toHaveBeenCalledWith(true, expect.anything());
        result = respond.mock.calls[0]?.[1];
      }
      expect(result, JSON.stringify(result)).toMatchObject({ status: "published" });
      expect(workspace.effects).toEqual(["push", "pull_request"]);
    },
  );

  it("rejects workflow edits introduced before confirmation without publishing them", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/later.yml");
    const reviewed = await f.reviewedRequest("immutable-workflows", f.publisher);
    const head = await workspace.git("rev-parse", "HEAD");
    const index = await fs.readFile(path.join(workspace.cwd, ".git/index"));
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    expect(await f.coordinator.requestForSession(reviewed)).toMatchObject({
      status: "failed",
      code: "workspace_changed",
    });
    expect(await workspace.git("rev-parse", "HEAD")).toBe(head);
    expect(await fs.readFile(path.join(workspace.cwd, ".git/index"))).toEqual(index);
    expect(await workspace.git("ls-tree", "HEAD", ".github/workflows")).toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
    expect(workspace.effects).toEqual([]);
  });

  it("publishes the reviewed tree while leaving later workflow edits unpublished", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/later.yml");
    const reviewed = await f.reviewedRequest("in-flight-workflows", f.publisher);
    const resolveRepository = mocks.resolveRepository.getMockImplementation()!;
    mocks.resolveRepository.mockImplementationOnce(async () => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, workflow);
      return await resolveRepository();
    });
    expect(await f.coordinator.requestForSession(reviewed)).toMatchObject({ status: "published" });
    expect(await workspace.git("rev-parse", "HEAD^{tree}")).toBe(
      reviewed.preparedReview.candidate.snapshot.workspaceTree,
    );
    expect(await workspace.git("ls-tree", "HEAD", ".github/workflows")).toBe("");
    expect(await workspace.git("ls-files", "--", ".github/workflows/later.yml")).toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
    expect(workspace.effects).toEqual(["push", "pull_request"]);
  });

  it("rechecks publication authority before push while settling an accepted local commit", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const reviewed = await f.reviewedRequest("permission-before-push", f.maintainer);
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.includes("update-ref")) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    expect(await f.coordinator.requestForSession(reviewed)).toMatchObject({
      status: "failed",
      code: "identity_changed",
    });
    expect(workspace.effects).toEqual([]);
    expect(await workspace.git("show", "HEAD:.github/workflows/example.yml")).toBe(workflow.trim());
    expect(await workspace.git("diff", "--cached", "HEAD")).toBe("");
    expect(await fs.readFile(file, "utf8")).toBe(workflow);
  });

  it("cleans an index reservation when publication authority closes before local CAS", async () => {
    const f = await createRequesters();
    const workspace = f.local;
    const file = path.join(workspace.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const head = await workspace.git("rev-parse", "HEAD");
    const reviewed = await f.reviewedRequest("permission-before-cas", f.maintainer);
    const transport = mocks.runCommand.getMockImplementation()!;
    mocks.runCommand.mockImplementation(async (args, options) => {
      const result = await transport(args, options);
      if (args.includes("write-tree") && options?.env?.GIT_INDEX_FILE?.endsWith("observed-index")) {
        await setCanonicalUserProfileRole(f.maintainerProfile, "revoked");
        invalidateOperatorRolePolicy(f.maintainerProfile);
      }
      return result;
    });
    await expect(f.coordinator.requestForSession(reviewed)).resolves.toMatchObject({
      status: "failed",
      code: "identity_changed",
    });
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

  it("rechecks the publisher after recording the push effect", async () => {
    const f = await createRequesters();
    const file = path.join(f.local.cwd, ".github/workflows/example.yml");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, workflow);
    const reviewed = await f.reviewedRequest("publisher-at-push", f.maintainer);
    const execute = publicationExecutor.executeGitHubPublication;
    let publisherRevoked = false;
    const intercepted = vi
      .spyOn(publicationExecutor, "executeGitHubPublication")
      .mockImplementation((params) =>
        execute({
          ...params,
          recordEffect: (effect, observed) => {
            params.recordEffect?.(effect, observed);
            if (effect === "push" && observed === undefined) {
              publisherRevoked = true;
              mocks.matchesIdentity.mockReturnValue(false);
            }
          },
        }),
      );
    onTestFinished(() => intercepted.mockRestore());

    await expect(f.coordinator.requestForSession(reviewed)).rejects.toThrow(
      GitHubPublicationRecoveryPendingError,
    );
    expect(publisherRevoked).toBe(true);
    expect(f.maintainer.assertCurrent).not.toThrow();
    expect(f.local.effects).toEqual([]);
    expect(f.externalWrites).toEqual([]);
  });
});
