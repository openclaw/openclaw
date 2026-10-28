import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import { callAgentToolGatewayRequest } from "../../agents/tools/in-process-gateway.js";
import { insertRegistryWorktree } from "../../agents/worktrees/registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.sqlite-entry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  createPluginRegistryFixture,
  registerTestPlugin,
} from "../../plugin-sdk/plugin-test-contracts.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../../plugins/tool-factory-runtime.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareGitHubPublicationSession } from "../github-publication-availability.js";
import { readPersonalGitLabPublicationAsync } from "../github-publication-store-async.js";
import { createPersonalGitLabOAuthLifecycle } from "../gitlab-personal-oauth.js";
import {
  personalGitLabRequestDigest,
  type PersonalGitLabPublicationRow,
} from "../gitlab-personal-publication-store.js";
import { insertPersonalGitLabPublicationInDatabase } from "../gitlab-personal-publication-store.worker.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  withAcceptedPluginGatewayHandoffClaim,
  type AcceptedPluginGatewayHandoffClaim,
} from "../plugin-tool-handoff-claim.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { resetTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { gitLabPublicationToolHandlers } from "./gitlab-publication-tool.js";
import { preparePersonalForgeAction } from "./personal-forge-authorization.js";

const publicationTransport = vi.hoisted(() => ({ remoteHead: null as string | null, pushes: 0 }));
vi.mock("../gitlab-publication-git.js", async (original) => ({
  ...(await original<typeof import("../gitlab-publication-git.js")>()),
  observeGitLabPublicationHead: async () => publicationTransport.remoteHead,
  pushGitLabPublicationCommit: async ({ git }: { git: { headCommit: string } }) => {
    publicationTransport.pushes++;
    publicationTransport.remoteHead = git.headCommit;
  },
}));

const { default: plugin } = await loadBundledPluginFacade<{ default: OpenClawPluginDefinition }>({
  pluginId: "gitlab",
  artifactBasename: "index.ts",
});

afterEach(() => {
  resetTestPluginRegistry();
  clearRuntimeConfigSnapshot();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("keeps registered publication status private to its signed-in owner after OAuth revocation", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const issuer = "https://gitlab.example.test";
    const config: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        gitlab: {
          issuer,
          clientId: "synthetic-client",
          redirectUri: "https://gateway.example.test/oauth/gitlab",
          projects: [91],
        },
      },
    };
    setRuntimeConfigSnapshot(config);
    const people = ["alice", "bob"].map((name) => {
      const id = name === "alice" ? 11 : 22;
      const profileId = ensureProfileForEmail(`${name}@example.test`).id;
      return {
        name,
        id,
        profileId,
        sessionKey: `agent:main:dashboard:${name}-publication`,
        sessionId: randomUUID(),
        requestId: "",
        client: createOperatorClient({
          profileId,
          scopes: ["operator.read", "operator.write"],
        }),
      };
    });
    const catalog = await prepareUserProfileCatalog();
    const service = createPersonalGitLabOAuthLifecycle(() => config);
    const handler = expectDefined(
      gitLabPublicationToolHandlers["tools.gitlab.publication.status"],
      "GitLab publication status handler",
    );
    const context = createContext(
      [
        [
          "tools.gitlab.publication.status",
          "operator.sessions.read",
          "gitlab-publication",
          handler,
        ],
      ],
      () => config,
    );
    context.gitlabOAuthService = service;
    context.getClientConnIds = (filter) =>
      new Set(
        people
          .filter(({ client }) => !filter || filter(client))
          .map(({ client }) => client.connId!),
      );
    const registration = createPluginRegistryFixture(config);
    registerTestPlugin({
      ...registration,
      record: createPluginRecord({
        id: "gitlab",
        origin: "bundled",
        contracts: {
          tools: ["gitlab_issues", "gitlab_publish"],
          gatewayMethodDispatch: ["authenticated-request"],
        },
      }),
      register: expectDefined(plugin.register, "GitLab plugin registration"),
    });
    const registry = registration.registry.registry;
    setActivePluginRegistry(registry);
    const entry = expectDefined(
      registry.tools.find(
        (candidate) =>
          candidate.pluginId === "gitlab" && candidate.names.includes("gitlab_publish"),
      ),
      "GitLab publication tool registration",
    );
    expect(entry.gatewayHandoffMethods).toEqual([
      "tools.gitlab.publication.publish",
      "tools.gitlab.publication.confirm",
    ]);
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.origin).toBe(issuer);
      expect(init?.redirect).toBe("error");
      if (url.pathname === "/oauth/token") {
        const code = (init!.body as URLSearchParams).get("code");
        return Response.json({
          access_token: `${code}-access`,
          refresh_token: `${code}-refresh`,
          token_type: "bearer",
          expires_in: 7200,
        });
      }
      const bearer = new Headers(init?.headers).get("Authorization");
      expect(bearer).not.toContain("ambient-bot");
      const person = expectDefined(
        people.find(({ name }) => bearer === `Bearer ${name}-access`),
        "Selected personal OAuth credential",
      );
      if (url.pathname === "/oauth/token/info") {
        return Response.json({ scope: ["api", "write_repository"] });
      }
      if (url.pathname === "/api/v4/user") {
        return Response.json({
          id: person.id,
          username: person.name,
          name: person.name,
          commit_email: `${person.name}@example.test`,
          bot: false,
        });
      }
      throw new Error(`Unexpected synthetic endpoint: ${url.pathname}`);
    });
    vi.stubGlobal("fetch", fetcher);
    vi.stubEnv("GITLAB_TOKEN", "ambient-bot");
    try {
      for (const person of people) {
        const action = await preparePersonalForgeAction(
          { client: person.client, context },
          "operator.read",
          undefined,
          "GitLab",
        );
        const started = await service.start(action);
        await service.complete(
          action,
          started.requestId,
          `${config.gateway!.gitlab!.redirectUri}?code=${person.name}&state=${new URL(started.authorizationUrl).searchParams.get("state")}`,
        );
        const credential = await service.credential(action);
        const session = await upsertSessionEntryCore(
          { agentId: "main", sessionKey: person.sessionKey },
          {
            sessionId: person.sessionId,
            updatedAt: Date.now(),
            createdActor: { type: "human", source: "profile", id: person.profileId },
          },
        );
        const now = Date.now();
        const row: PersonalGitLabPublicationRow = {
          request_id: randomUUID(),
          owner_profile_id: person.profileId,
          issuer,
          connection_generation: credential.generation,
          idempotency_key: randomUUID(),
          request_digest: "",
          session_id: person.sessionId,
          session_key: person.sessionKey,
          agent_id: "main",
          session_lifecycle_revision: session?.lifecycleRevision ?? null,
          worktree_id: `worktree-${person.name}`,
          repository_fingerprint: `fingerprint-${person.name}`,
          identity_account_id: person.id,
          identity_login: person.name,
          branch: `topic-${person.name}`,
          receipt_json: "",
          status: "failed",
          gateway_instance_id: null,
          execution_id: null,
          head_commit: null,
          pull_request_url: null,
          error_code: "unavailable",
          next_action: "Inspect the original request before retrying.",
          last_effect: null,
          effect_state: null,
          push_observation: null,
          result_json: "",
          created_at_ms: now,
          updated_at_ms: now,
          reported_at_ms: null,
        };
        row.receipt_json = JSON.stringify({
          target: {
            issuer,
            projectId: 91,
            projectPath: "team/app",
            gitUrl: `${issuer}/team/app.git`,
            webUrl: `${issuer}/team/app`,
            baseBranch: "master",
          },
          sessionIdentity: {
            sessionId: person.sessionId,
            sessionKey: person.sessionKey,
            agentId: "main",
            lifecycleRevision: row.session_lifecycle_revision,
          },
          sourceId: row.worktree_id,
          worktreeId: row.worktree_id,
          repositoryRoot: state.workspaceDir,
          repositoryFingerprint: row.repository_fingerprint,
          actor: { accountId: person.id, login: person.name },
          title: "Draft: Synthetic publication",
          description: "Synthetic",
          draft: true,
          sourceHead: "a".repeat(40),
          baseTree: "b".repeat(40),
          workspaceHead: "c".repeat(40),
          sourceIndexTree: "b".repeat(40),
          branch: row.branch,
          createdAtMs: now,
          previousHeadCommit: null,
        });
        row.request_digest = personalGitLabRequestDigest(row);
        row.result_json = JSON.stringify({
          status: "failed",
          requestId: row.request_id,
          code: "unavailable",
          message: "Synthetic response uncertain.",
          nextAction: row.next_action,
        });
        runOpenClawStateWriteTransaction((database) =>
          insertPersonalGitLabPublicationInDatabase(database, row, () => {}),
        );
        person.requestId = row.request_id;
      }
      const invoke = async (
        person: (typeof people)[number],
        operation:
          | { action: "status"; requestId: string }
          | { action: "publish"; title: string; draft: true; bootstrapDraft: true },
        sessionKey = person.sessionKey,
      ) => {
        const captured = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: person.client,
            context,
            hasCurrentClientAuthority: () => !person.client.invalidated,
          }),
          "Admitted requester authority",
        );
        let current = true;
        const factoryContext = createPluginToolFactoryContext({
          entry,
          registry,
          context: { agentId: "main", sessionKey },
          assertInvocationCurrent: () => {
            if (!current) {
              throw new Error("tool retired");
            }
          },
        });
        const raw = entry.factory(factoryContext);
        if (!raw || Array.isArray(raw)) {
          throw new Error("GitLab publication tool missing");
        }
        const tool = bindPluginToolCallbacks(
          entry,
          registry,
          raw,
          factoryContext.assertInvocationCurrent,
        );
        try {
          return await withPluginRuntimeGatewayRequestScope(
            { client: person.client, context, isWebchatConnect: () => false },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey,
                  operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
                  operatorAuthority: captured.authority,
                  receiptAuthority: () => current,
                  assertToolAllowed: (name) => {
                    if (name !== "gitlab_publish") {
                      throw new Error("tool denied");
                    }
                  },
                  gatewayContextResolver: () => context,
                },
                () => tool.execute(randomUUID(), operation),
              ),
          );
        } finally {
          current = false;
          captured.release();
        }
      };
      const alice = people[0]!;
      const bob = people[1]!;
      const aliceRequestId = alice.requestId;
      const bobRequestId = bob.requestId;
      const aliceOtherSessionKey = "agent:main:dashboard:alice-other-publication";
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: aliceOtherSessionKey },
        {
          sessionId: randomUUID(),
          updatedAt: Date.now(),
          createdActor: { type: "human", source: "profile", id: alice.profileId },
        },
      );
      const fetchCount = fetcher.mock.calls.length;
      await expect(
        invoke(alice, {
          action: "publish",
          title: "Draft: Synthetic publication",
          draft: true,
          bootstrapDraft: true,
        }),
      ).rejects.toThrow("native conversation handoff support");
      expect(fetcher).toHaveBeenCalledTimes(fetchCount);
      await expect(
        invoke(alice, { action: "status", requestId: aliceRequestId }),
      ).resolves.toMatchObject({
        details: { result: { requestId: aliceRequestId, status: "failed", code: "unavailable" } },
      });
      await expect(invoke(bob, { action: "status", requestId: aliceRequestId })).rejects.toThrow();
      await expect(
        invoke(alice, { action: "status", requestId: aliceRequestId }, aliceOtherSessionKey),
      ).rejects.toThrow();
      await expect(
        invoke(bob, { action: "status", requestId: bobRequestId }),
      ).resolves.toMatchObject({
        details: { result: { requestId: bobRequestId, status: "failed", code: "unavailable" } },
      });
      // A terminal accepted receipt remains visible after the selected grant is gone.
      await service.disconnect(
        await preparePersonalForgeAction(
          { client: alice.client, context },
          "operator.read",
          undefined,
          "GitLab",
        ),
      );
      alice.client.connect.scopes = ["operator.sessions.read"];
      await expect(
        invoke(alice, { action: "status", requestId: aliceRequestId }),
      ).resolves.toMatchObject({
        details: { result: { requestId: aliceRequestId, status: "failed", code: "unavailable" } },
      });
      expect(
        fetcher.mock.calls.every(
          ([, init]) => new Headers(init?.headers).get("Authorization") !== "Bearer ambient-bot",
        ),
      ).toBe(true);
    } finally {
      await service.stop();
      catalog.release();
    }
  });
});

it.each(["normal", "lost-mr-response", "canonical-mismatch", "policy-revoked", "revoked"] as const)(
  "keeps requester publication authority through native RPC (%s)",
  async (scenario) => {
    const lostMrResponse = scenario === "lost-mr-response";
    const unbound = scenario === "canonical-mismatch" || scenario === "policy-revoked";
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "gitlab-rpc-publication-"));
      const cwd = path.join(repoRoot, "topic");
      const git = (...args: string[]) =>
        execFileSync("git", args, {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: os.devNull,
            GIT_CONFIG_SYSTEM: os.devNull,
            GIT_TERMINAL_PROMPT: "0",
          },
        }).trim();
      const worktreeGit = (...args: string[]) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_CONFIG_GLOBAL: os.devNull,
            GIT_CONFIG_SYSTEM: os.devNull,
            GIT_TERMINAL_PROMPT: "0",
          },
        }).trim();
      const issuer = "https://gitlab.example.test";
      const project = {
        id: 17,
        path_with_namespace: "group/repo",
        http_url_to_repo: `${issuer}/group/repo.git`,
        web_url: `${issuer}/group/repo`,
        default_branch: "master",
      };
      const config: OpenClawConfig = {
        agents: { entries: { main: { workspace: state.workspaceDir } } },
        gateway: {
          gitlab: {
            issuer,
            clientId: "synthetic-client",
            redirectUri: "https://gateway.example.test/oauth/gitlab",
            projects: [17],
          },
        },
      };
      let projectMetadataFetched = false;
      let projectPolicyReadsAfterMetadata = 0;
      if (scenario === "policy-revoked") {
        Object.defineProperty(config.gateway!.gitlab!, "projects", {
          enumerable: true,
          get() {
            if (!projectMetadataFetched) {
              return [17];
            }
            projectPolicyReadsAfterMetadata++;
            return projectPolicyReadsAfterMetadata <= 2 ? [17] : [99];
          },
        });
      }
      setRuntimeConfigSnapshot(config);
      const catalog = await prepareUserProfileCatalog();
      const service = createPersonalGitLabOAuthLifecycle(() => config);
      try {
        git("init", "--initial-branch=master");
        git("config", "user.name", "Fixture");
        git("config", "user.email", "fixture@example.test");
        await fs.writeFile(path.join(repoRoot, "artifact.txt"), "base\n");
        git("add", "artifact.txt");
        git("commit", "-m", "Synthetic source");
        const source = git("rev-parse", "HEAD");
        git("worktree", "add", "-b", "topic", cwd);
        git("remote", "add", "origin", project.http_url_to_repo);
        publicationTransport.remoteHead = null;
        publicationTransport.pushes = 0;
        const aliceProfile = ensureProfileForEmail("rpc-alice@example.test").id;
        const bobProfile = ensureProfileForEmail("rpc-bob@example.test").id;
        const alice = createOperatorClient({
          profileId: aliceProfile,
          scopes: ["operator.read", "operator.write", ...(unbound ? ["operator.admin"] : [])],
        });
        alice.internal = { ...alice.internal, operatorAccessAuthority: null };
        const bob = createOperatorClient({
          profileId: bobProfile,
          scopes: ["operator.read", "operator.write"],
        });
        bob.internal = { ...bob.internal, operatorAccessAuthority: null };
        const sessionId = randomUUID();
        const sessionKey = `agent:main:dashboard:${randomUUID()}`;
        const worktreeId = randomUUID();
        if (!unbound) {
          await insertRegistryWorktree(process.env, {
            id: worktreeId,
            path: cwd,
            repoRoot,
            repoFingerprint: `rpc-${sessionId}`,
            branch: "topic",
            name: "topic",
            baseRef: "origin/master",
            ownerKind: "session",
            ownerId: sessionKey,
            createdAt: 1_000,
            lastActiveAt: 1_000,
          });
        }
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId,
            updatedAt: Date.now(),
            createdActor: { type: "human", source: "profile", id: aliceProfile },
            ...(unbound ? {} : { worktree: { id: worktreeId, repoRoot, branch: "topic" } }),
          },
        );
        const handler = expectDefined(
          gitLabPublicationToolHandlers["tools.gitlab.publication.publish"],
          "registered publish handler",
        );
        const statusHandler = expectDefined(
          gitLabPublicationToolHandlers["tools.gitlab.publication.status"],
          "registered status handler",
        );
        const confirmHandler = expectDefined(
          gitLabPublicationToolHandlers["tools.gitlab.publication.confirm"],
          "registered confirm handler",
        );
        const context = createContext(
          [
            [
              "tools.gitlab.publication.publish",
              "operator.sessions.write",
              "gitlab-publication",
              handler,
            ],
            [
              "tools.gitlab.publication.status",
              "operator.sessions.read",
              "gitlab-publication",
              statusHandler,
            ],
            [
              "tools.gitlab.publication.confirm",
              "operator.sessions.write",
              "gitlab-publication",
              confirmHandler,
            ],
          ],
          () => config,
        );
        context.gitlabOAuthService = service;
        context.getSessionEventSubscriberConnIds = () => new Set();
        context.getClientConnIds = (filter) =>
          new Set(
            [alice, bob]
              .filter((client) => !filter || filter(client))
              .map((client) => client.connId!),
          );
        context.workerSessionPlacementService = {
          workspaceResultInstanceId: () => "rpc-fixture-instance",
          withLocalWorkspaceReservation: async (_target, run) => run(() => {}),
        } as typeof context.workerSessionPlacementService;
        const registration = createPluginRegistryFixture(config);
        registerTestPlugin({
          ...registration,
          record: createPluginRecord({
            id: "gitlab",
            origin: "bundled",
            contracts: {
              tools: ["gitlab_issues", "gitlab_publish"],
              gatewayMethodDispatch: ["authenticated-request"],
            },
          }),
          register: expectDefined(plugin.register, "GitLab plugin registration"),
        });
        setActivePluginRegistry(registration.registry.registry);
        const entry = expectDefined(
          registration.registry.registry.tools.find(
            (candidate) =>
              candidate.pluginId === "gitlab" && candidate.names.includes("gitlab_publish"),
          ),
          "GitLab publication tool registration",
        );
        const mrs: Array<Record<string, unknown>> = [];
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          expect(url.origin).toBe(issuer);
          expect(init?.redirect).toBe("error");
          if (url.pathname === "/oauth/token") {
            const code = (init!.body as URLSearchParams).get("code");
            return Response.json({
              access_token: `${code}-access`,
              refresh_token: `${code}-refresh`,
              token_type: "bearer",
              expires_in: 7200,
            });
          }
          const bearer = new Headers(init?.headers).get("Authorization");
          expect(bearer).not.toContain("ambient-bot");
          const actor =
            bearer === "Bearer alice-access" ? 11 : bearer === "Bearer bob-access" ? 22 : 0;
          expect(actor).not.toBe(0);
          if (url.pathname === "/oauth/token/info") {
            return Response.json({ scope: ["api", "write_repository"] });
          }
          if (url.pathname === "/api/v4/user") {
            return Response.json({
              id: actor,
              username: actor === 11 ? "alice" : "bob",
              name: actor === 11 ? "Alice Human" : "Bob Human",
              commit_email: actor === 11 ? "alice@example.test" : "bob@example.test",
              bot: false,
            });
          }
          expect(actor).toBe(11);
          const endpoint = url.pathname.replace("/api/v4/", "");
          if (endpoint === "projects/group%2Frepo" || endpoint === "projects/17") {
            if (endpoint === "projects/group%2Frepo") {
              projectMetadataFetched = true;
            }
            return Response.json(
              scenario === "canonical-mismatch" && endpoint === "projects/group%2Frepo"
                ? { ...project, web_url: "https://different.example.test/group/repo" }
                : project,
            );
          }
          if (endpoint === "projects/17/repository/branches/master") {
            return Response.json({ name: "master", commit: { id: source } });
          }
          if (endpoint === "projects/17/repository/branches/topic") {
            return publicationTransport.remoteHead
              ? Response.json({ name: "topic", commit: { id: publicationTransport.remoteHead } })
              : Response.json({}, { status: 404 });
          }
          if (endpoint === `projects/17/repository/commits/${source}`) {
            return Response.json({ id: source });
          }
          if (endpoint === "projects/17/merge_requests" && init?.method === "GET") {
            return Response.json(mrs);
          }
          if (endpoint === "projects/17/merge_requests" && init?.method === "POST") {
            const body = JSON.parse(typeof init.body === "string" ? init.body : "") as {
              description: string;
              title: string;
            };
            mrs.push({
              iid: 9,
              web_url: `${project.web_url}/-/merge_requests/9`,
              state: "opened",
              source_project_id: 17,
              target_project_id: 17,
              source_branch: "topic",
              target_branch: "master",
              sha: publicationTransport.remoteHead,
              author: { id: actor },
              description: body.description,
              title: body.title,
            });
            if (lostMrResponse) {
              throw new Error("Synthetic MR response lost after creation");
            }
            return Response.json(mrs[0]);
          }
          if (endpoint === "projects/17/merge_requests/9") {
            return Response.json(mrs[0]);
          }
          throw new Error(`Unexpected synthetic endpoint ${init?.method} ${endpoint}`);
        });
        vi.stubGlobal("fetch", fetcher);
        vi.stubEnv("GITLAB_TOKEN", "ambient-bot");
        for (const [client, name] of [
          [alice, "alice"],
          [bob, "bob"],
        ] as const) {
          const action = await preparePersonalForgeAction(
            { client, context },
            "operator.read",
            undefined,
            "GitLab",
          );
          const started = await service.start(action);
          await service.complete(
            action,
            started.requestId,
            `${config.gateway!.gitlab!.redirectUri}?code=${name}&state=${new URL(started.authorizationUrl).searchParams.get("state")}`,
          );
        }
        const captured = expectDefined(
          await captureGatewayOperatorRunAuthority({
            client: alice,
            context,
            hasCurrentClientAuthority: () => !alice.invalidated,
          }),
          "Alice run authority",
        );
        let current = true;
        const operation = {
          action: "publish" as const,
          title: "Draft: Initial work",
          draft: true,
          bootstrapDraft: true,
          ...(unbound ? { workspacePath: cwd } : {}),
        };
        const params = { sessionKey, agentId: "main", idempotencyKey: randomUUID(), operation };
        const claim = {
          pluginId: "gitlab",
          toolName: "gitlab_publish",
          method: "tools.gitlab.publication.publish",
          params,
          agentId: "main",
          sessionKey,
          sessionId,
          operatorAuthority: captured.authority,
          signal: new AbortController().signal,
          assertCurrent() {
            if (!current) {
              throw new Error("accepted handoff retired");
            }
            captured.authority.assertCurrent();
          },
        };
        const dispatch = (selectedClaim: AcceptedPluginGatewayHandoffClaim = claim) =>
          withPluginRuntimeGatewayRequestScope(
            {
              client: alice,
              context,
              isWebchatConnect: () => false,
              pluginId: "gitlab",
              pluginRegistry: registration.registry.registry,
            },
            () =>
              withGatewayToolCallerIdentity(
                {
                  agentId: "main",
                  sessionKey,
                  operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
                  operatorAuthority: captured.authority,
                  receiptAuthority: () => current,
                  assertToolAllowed: (name) => {
                    if (name !== "gitlab_publish") {
                      throw new Error("tool denied");
                    }
                  },
                  gatewayContextResolver: () => context,
                },
                () =>
                  callAgentToolGatewayRequest({
                    method: selectedClaim.method,
                    params: selectedClaim.params,
                    scopes: ["operator.sessions.write"],
                    signal: selectedClaim.signal,
                    timeoutMs: null,
                    sessionMutationCommitGuard: () => selectedClaim.assertCurrent(),
                  }),
              ),
          );
        try {
          if (scenario === "revoked") {
            await service.disconnect(
              await preparePersonalForgeAction(
                { client: alice, context },
                "operator.read",
                undefined,
                "GitLab",
              ),
            );
            await expect(withAcceptedPluginGatewayHandoffClaim(claim, dispatch)).rejects.toThrow();
            expect(publicationTransport.pushes).toBe(0);
            expect(mrs).toHaveLength(0);
            expect(
              await readPersonalGitLabPublicationAsync(aliceProfile, issuer, {
                sessionKey,
                agentId: "main",
              }),
            ).toBeUndefined();
            return;
          }
          if (unbound) {
            await expect(withAcceptedPluginGatewayHandoffClaim(claim, dispatch)).rejects.toThrow(
              scenario === "canonical-mismatch"
                ? "GitLab publication project identity changed"
                : "GitLab publication project is not allowed",
            );
            using selected = await prepareGitHubPublicationSession(sessionKey, { agentId: "main" });
            expect(selected.readCurrent().entry?.worktree).toBeUndefined();
            if (scenario === "policy-revoked") {
              expect(projectPolicyReadsAfterMetadata).toBeGreaterThanOrEqual(3);
            }
            expect(publicationTransport.pushes).toBe(0);
            expect(mrs).toHaveLength(0);
            expect(
              await readPersonalGitLabPublicationAsync(aliceProfile, issuer, {
                sessionKey,
                agentId: "main",
              }),
            ).toBeUndefined();
            return;
          }
          let result = await withAcceptedPluginGatewayHandoffClaim(claim, dispatch);
          if (lostMrResponse) {
            expect(result).toMatchObject({ status: "needs_confirmation" });
            const factoryContext = createPluginToolFactoryContext({
              entry,
              registry: registration.registry.registry,
              context: { agentId: "main", sessionKey },
              assertInvocationCurrent: () => {
                if (!current) {
                  throw new Error("tool retired");
                }
              },
            });
            const raw = entry.factory(factoryContext);
            if (!raw || Array.isArray(raw)) {
              throw new Error("GitLab publication tool missing");
            }
            const tool = bindPluginToolCallbacks(
              entry,
              registration.registry.registry,
              raw,
              factoryContext.assertInvocationCurrent,
            );
            const statusToolResult = await withPluginRuntimeGatewayRequestScope(
              {
                client: alice,
                context,
                isWebchatConnect: () => false,
                pluginId: "gitlab",
                pluginRegistry: registration.registry.registry,
              },
              () =>
                withGatewayToolCallerIdentity(
                  {
                    agentId: "main",
                    sessionKey,
                    operationalRunInstance: { instanceId: "instance-1", runId: "run-1" },
                    operatorAuthority: captured.authority,
                    receiptAuthority: () => current,
                    assertToolAllowed: () => {},
                    gatewayContextResolver: () => context,
                  },
                  () =>
                    tool.execute(randomUUID(), {
                      action: "status",
                      requestId: (result as { requestId: string }).requestId,
                    }),
                ),
            );
            const status = statusToolResult.details as {
              result: { requestId: string; status: string };
              confirmation: {
                requestDigest: string;
                generation: string;
                account: { accountId: number; login: string };
              };
            };
            expect(status.result.status).toBe("needs_confirmation");
            const confirmClaim = {
              ...claim,
              method: "tools.gitlab.publication.confirm",
              params: {
                sessionKey,
                agentId: "main",
                idempotencyKey: randomUUID(),
                operation: {
                  action: "confirm" as const,
                  requestId: status.result.requestId,
                  requestDigest: status.confirmation.requestDigest,
                  generation: status.confirmation.generation,
                  account: status.confirmation.account,
                },
              },
            };
            result = await withAcceptedPluginGatewayHandoffClaim(confirmClaim, () =>
              dispatch(confirmClaim),
            );
          }
          expect(result).toMatchObject({
            status: "published",
            publisher: { source: "personal", accountId: 11, login: "alice" },
            url: `${project.web_url}/-/merge_requests/9`,
          });
          expect(publicationTransport.pushes).toBe(1);
          expect(mrs).toHaveLength(1);
          expect(mrs[0]).toMatchObject({
            author: { id: 11 },
            sha: publicationTransport.remoteHead,
          });
          expect(worktreeGit("show", "-s", "--format=%an|%ae|%cn|%ce", "HEAD")).toBe(
            "Alice Human|alice@example.test|Alice Human|alice@example.test",
          );
          expect(worktreeGit("rev-parse", "HEAD^")).toBe(source);
          const publishedRequestId = (result as { requestId: string }).requestId;
          const bobAuthority = expectDefined(
            await captureGatewayOperatorRunAuthority({ client: bob, context }),
            "Bob run authority",
          );
          try {
            const bobFactoryContext = createPluginToolFactoryContext({
              entry,
              registry: registration.registry.registry,
              context: { agentId: "main", sessionKey },
              assertInvocationCurrent: () => {},
            });
            const bobRaw = entry.factory(bobFactoryContext);
            if (!bobRaw || Array.isArray(bobRaw)) {
              throw new Error("GitLab publication tool missing");
            }
            const bobTool = bindPluginToolCallbacks(
              entry,
              registration.registry.registry,
              bobRaw,
              bobFactoryContext.assertInvocationCurrent,
            );
            await expect(
              withPluginRuntimeGatewayRequestScope(
                { client: bob, context, isWebchatConnect: () => false },
                () =>
                  withGatewayToolCallerIdentity(
                    {
                      agentId: "main",
                      sessionKey,
                      operationalRunInstance: { instanceId: "instance-bob", runId: "run-bob" },
                      operatorAuthority: bobAuthority.authority,
                      receiptAuthority: () => true,
                      assertToolAllowed: () => {},
                      gatewayContextResolver: () => context,
                    },
                    () =>
                      bobTool.execute(randomUUID(), {
                        action: "status",
                        requestId: publishedRequestId,
                      }),
                  ),
              ),
            ).rejects.toThrow();
          } finally {
            bobAuthority.release();
          }
          await expect(dispatch()).rejects.toThrow("accepted plugin tool handoff");
        } finally {
          current = false;
          captured.release();
        }
      } finally {
        await service.stop();
        catalog.release();
        await fs.rm(repoRoot, { recursive: true, force: true });
      }
    });
  },
);
