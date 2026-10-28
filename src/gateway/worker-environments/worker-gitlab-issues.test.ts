import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { createPluginRecord } from "../../plugins/status.test-helpers.js";
import { createPluginToolFactoryContext } from "../../plugins/tool-factory-context.js";
import { bindPluginToolCallbacks } from "../../plugins/tool-factory-runtime.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureProfileForEmail } from "../../state/user-profiles.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import { createPersonalGitLabOAuthLifecycle } from "../gitlab-personal-oauth.js";
import { gitLabIssueHandlers } from "../server-methods/gitlab-issues.js";
import { preparePersonalForgeAction } from "../server-methods/personal-forge-authorization.js";
import {
  createContext,
  createOperatorClient,
} from "../server-plugin-in-process-dispatch.test-support.js";
import { resetTestPluginRegistry } from "../test-helpers.plugin-registry.js";
// Register the worker test doubles before loading its tool runtime.
import {
  installWorkerSessionToolTestFixture,
  SOURCE,
  workerSessionToolTestMocks,
} from "./worker-session-tool-executor.test-support.js";

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

describe("placed worker GitLab issue tool", () => {
  const getFixture = installWorkerSessionToolTestFixture(workerSessionToolTestMocks(), {
    operatorProfileEmail: "alice@example.test",
    operatorScopes: ["operator.read", "operator.write"],
  });

  it("uses only its admitted requester's OAuth grant and rejects missing and revoked grants", async () => {
    const {
      placements,
      sourceClaim,
      identity,
      setEntry,
      createToolRuntime,
      revokeOperatorAuthority,
    } = getFixture();
    const issuer = "https://gitlab.example.test";
    const projectUrl = `${issuer}/team/app`;
    const config: OpenClawConfig = {
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
    setEntry(SOURCE.sessionKey, SOURCE.sessionId);
    await placements.authorizeWorkerTurnTools(sourceClaim, ["gitlab_issues"]);
    const alice = ensureProfileForEmail("alice@example.test");
    const bob = ensureProfileForEmail("bob@example.test");
    const people = [
      {
        name: "alice",
        client: createOperatorClient({
          profileId: alice.id,
          scopes: ["operator.read", "operator.write"],
        }),
      },
      {
        name: "bob",
        client: createOperatorClient({
          profileId: bob.id,
          scopes: ["operator.read", "operator.write"],
        }),
      },
    ];
    const catalog = await prepareUserProfileCatalog();
    const service = createPersonalGitLabOAuthLifecycle(() => config);
    const context = createContext(
      [
        [
          "tools.gitlab.issues.read",
          "operator.sessions.read",
          "gitlab-issues",
          expectDefined(gitLabIssueHandlers["tools.gitlab.issues.read"], "GitLab read handler"),
        ],
        [
          "tools.gitlab.issues.write",
          "operator.sessions.write",
          "gitlab-issues",
          expectDefined(gitLabIssueHandlers["tools.gitlab.issues.write"], "GitLab write handler"),
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
    const effects: Array<{ actor: string; body: string }> = [];
    let effectId = 700;
    vi.stubEnv("GITLAB_TOKEN", "ambient-bot");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input, init) => {
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
        const person =
          authorization === "Bearer alice-access"
            ? alice
            : authorization === "Bearer bob-access"
              ? bob
              : undefined;
        expect(person).toBeDefined();
        const name = person?.id === alice.id ? "alice" : "bob";
        if (url.pathname === "/oauth/token/info") {
          return Response.json({ scope: ["api", "write_repository"] });
        }
        if (url.pathname === "/api/v4/user") {
          return Response.json({
            id: name === "alice" ? 11 : 22,
            username: name,
            name,
            commit_email: `${name}@example.test`,
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
        if (url.pathname === "/api/v4/projects/91/issues/12/notes" && init?.method === "POST") {
          if (typeof init.body !== "string") {
            throw new Error("Expected JSON note request");
          }
          const body = JSON.parse(init.body).body as string;
          effects.push({ actor: name, body });
          return Response.json(
            {
              id: ++effectId,
              body,
              author: { id: name === "alice" ? 11 : 22 },
              system: false,
              created_at: "2026-10-27T12:01:00Z",
              updated_at: "2026-10-27T12:01:00Z",
            },
            { status: 201 },
          );
        }
        throw new Error(`Unexpected synthetic GitLab endpoint: ${url.pathname}`);
      }),
    );
    const runtime = createToolRuntime({
      resolveGatewayContext: () => context,
      prepareTools: () => {
        const factoryContext = createPluginToolFactoryContext({
          entry,
          registry,
          context: {},
          assertInvocationCurrent: () => {},
        });
        const raw = entry.factory(factoryContext);
        if (!raw || Array.isArray(raw)) {
          throw new Error("GitLab tool missing");
        }
        return [
          bindPluginToolCallbacks(entry, registry, raw, factoryContext.assertInvocationCurrent),
        ];
      },
    });
    const invoke = async (toolCallId: string) => {
      const surface = await runtime.getSurface(identity);
      const tool = expectDefined(
        surface.tools.find((item) => item.definition.name === "gitlab_issues"),
        "Admitted GitLab worker tool",
      );
      return await runtime.invoke(
        identity,
        {
          generation: surface.generation,
          toolId: tool.id,
          toolCallId,
          arguments: {
            action: "note.create",
            projectUrl,
            target: "issue",
            iid: 12,
            body: "Requested by alice",
          },
        },
        { send: () => {} },
      );
    };
    try {
      const missing = await invoke("missing-grant");
      expect(missing.isError).toBe(true);
      expect(JSON.stringify(missing)).toContain("Connect your personal GitLab account");
      expect(effects).toEqual([]);
      for (const { name, client } of people.toReversed()) {
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
      const result = await invoke("alice-comment");
      expect(result.isError).not.toBe(true);
      expect(result.details).toMatchObject({
        actor: { accountId: 11 },
        effect: { authorId: 11, outcome: "observed" },
      });
      expect(effects).toEqual([{ actor: "alice", body: "Requested by alice" }]);
      revokeOperatorAuthority();
      const revoked = await invoke("revoked-requester");
      expect(revoked.isError).toBe(true);
      expect(JSON.stringify(revoked)).toContain("source operator authority revoked");
      expect(effects).toHaveLength(1);
    } finally {
      await service.stop();
      catalog.release();
    }
  });
});
