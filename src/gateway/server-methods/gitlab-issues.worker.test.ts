import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, expect, it, vi } from "vitest";
import { withGatewayToolCallerIdentity } from "../../agents/tools/gateway-caller-context.js";
import {
  setRuntimeConfigSnapshot,
  clearRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
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
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createPersonalGitLabOAuthLifecycle } from "../gitlab-personal-oauth.js";
import { captureGatewayOperatorRunAuthority } from "../operator-run-authority.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { resetTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { gitLabIssueHandlers } from "./gitlab-issues.js";
import { preparePersonalForgeAction } from "./personal-forge-authorization.js";

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

it("routes two people's issue and MR comments through the registered tool using their own OAuth grants", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const issuer = "https://gitlab.example.test";
    const projectUrl = `${issuer}/team/app`;
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
    const people = ["alice", "bob"].map((name) => ({
      name,
      id: name === "alice" ? 11 : 22,
      client: createOperatorClient({
        profileId: ensureProfileForEmail(`${name}@example.test`).id,
        scopes: ["operator.read", "operator.write"],
      }),
    }));
    const catalog = await prepareUserProfileCatalog();
    const service = createPersonalGitLabOAuthLifecycle(() => config);
    const context = createContext(
      [
        [
          "tools.gitlab.issues.read",
          "operator.sessions.read",
          "gitlab-issues",
          expectDefined(
            gitLabIssueHandlers["tools.gitlab.issues.read"],
            "GitLab issue read handler",
          ),
        ],
        [
          "tools.gitlab.issues.write",
          "operator.sessions.write",
          "gitlab-issues",
          expectDefined(
            gitLabIssueHandlers["tools.gitlab.issues.write"],
            "GitLab issue write handler",
          ),
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
          tools: ["gitlab_issues"],
          gatewayMethodDispatch: ["authenticated-request"],
        },
      }),
      register: expectDefined(plugin.register, "GitLab plugin registration"),
    });
    const registry = registration.registry.registry;
    setActivePluginRegistry(registry);
    const entry = expectDefined(
      registry.tools.find((tool) => tool.pluginId === "gitlab"),
      "GitLab tool registration",
    );
    const effects: { actor: string; path: string; body: string }[] = [];
    let effectId = 700;
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
      const authorization = new Headers(init?.headers).get("Authorization");
      expect(authorization).not.toContain("ambient-bot");
      const person = expectDefined(
        people.find(({ name }) => authorization === `Bearer ${name}-access`),
        "Selected synthetic OAuth account",
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
      if (url.pathname === "/api/v4/projects/team%2Fapp") {
        return Response.json({ id: 91, path_with_namespace: "team/app", web_url: projectUrl });
      }
      if (url.pathname === "/api/v4/projects/91/issues/12") {
        return Response.json({
          id: 501,
          iid: 12,
          project_id: 91,
          web_url: `${projectUrl}/-/issues/12`,
          title: "Existing issue",
          description: "Synthetic",
          state: "opened",
          updated_at: "2026-10-27T12:00:00Z",
          labels: [],
          assignees: [],
          milestone: null,
          due_date: null,
          author: { id: 99 },
        });
      }
      if (url.pathname === "/api/v4/projects/91/merge_requests/8") {
        return Response.json({
          id: 508,
          iid: 8,
          project_id: 91,
          web_url: `${projectUrl}/-/merge_requests/8`,
          title: "Existing MR",
          description: "Synthetic",
          state: "opened",
          sha: "a".repeat(40),
          diff_refs: {
            base_sha: "b".repeat(40),
            head_sha: "a".repeat(40),
            start_sha: "c".repeat(40),
          },
          author: { id: 99 },
        });
      }
      if (url.pathname.endsWith("/notes") && init?.method === "POST") {
        if (typeof init.body !== "string") {
          throw new Error("Expected a JSON note request");
        }
        const body = JSON.parse(init.body).body as string;
        effects.push({ actor: person.name, path: url.pathname, body });
        return Response.json(
          {
            id: ++effectId,
            body,
            author: { id: person.id },
            system: false,
            created_at: "2026-10-27T12:01:00Z",
            updated_at: "2026-10-27T12:01:00Z",
          },
          { status: 201 },
        );
      }
      throw new Error(`Unexpected synthetic GitLab endpoint: ${url.pathname}`);
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
      }
      const invoke = async (index: number, target: "issue" | "merge_request") => {
        const person = people[index]!;
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
          context: {},
          assertInvocationCurrent: () => {
            if (!current) {
              throw new Error("tool retired");
            }
          },
        });
        const raw = entry.factory(factoryContext);
        if (!raw || Array.isArray(raw)) {
          throw new Error("GitLab tool missing");
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
                  sessionKey: "agent:main:dashboard:shared-project",
                  operationalRunInstance: {
                    instanceId: `instance-${index}`,
                    runId: `run-${index}`,
                  },
                  operatorAuthority: captured.authority,
                  receiptAuthority: () => current,
                  assertToolAllowed: (name) => {
                    if (name !== "gitlab_issues") {
                      throw new Error("tool denied");
                    }
                  },
                  gatewayContextResolver: () => context,
                },
                () =>
                  tool.execute(`comment-${index}`, {
                    action: "note.create",
                    projectUrl,
                    target,
                    iid: target === "issue" ? 12 : 8,
                    body: `Requested by ${person.name}`,
                  }),
              ),
          );
        } finally {
          current = false;
          captured.release();
        }
      };
      const [aliceResult, bobResult] = await Promise.all([
        invoke(0, "issue"),
        invoke(1, "merge_request"),
      ]);
      expect(aliceResult.details).toMatchObject({
        actor: { accountId: 11 },
        effect: { authorId: 11, outcome: "observed" },
      });
      expect(bobResult.details).toMatchObject({
        actor: { accountId: 22 },
        effect: { authorId: 22, outcome: "observed" },
      });
      expect(effects.toSorted((a, b) => a.actor.localeCompare(b.actor))).toEqual([
        { actor: "alice", path: "/api/v4/projects/91/issues/12/notes", body: "Requested by alice" },
        {
          actor: "bob",
          path: "/api/v4/projects/91/merge_requests/8/notes",
          body: "Requested by bob",
        },
      ]);
    } finally {
      await service.stop();
      catalog.release();
    }
  });
});
