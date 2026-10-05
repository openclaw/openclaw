import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as oauth from "../../agents/github-oauth-client.js";
import * as nativeIdentity from "../../agents/github-read-identity.js";
import { resolveManagedGitHubProfileDir } from "../../agents/github-tool-identity.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "../../plugin-sdk/plugin-test-contracts.js";
import type { OpenClawPluginDefinition } from "../../plugins/types.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { linkCanonicalUserProfileEmail } from "../../state/user-profile-writes.js";
import { loadBundledPluginFacade } from "../../test-utils/bundled-plugin-public-surface.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "../control-ui-session-pr-access.test-support.js";
import {
  FACTORY_GITHUB_PROOF_ENV,
  factoryGitHubRequestDigest,
  redeemFactoryGitHubProof,
  type FactoryGitHubProofVerdict,
} from "../factory-github-proof.js";
import * as oauthLifecycle from "../github-oauth-lifecycle.js";
import { gitHubPublicApi } from "../github-public-api.js";
import { createGatewayMethodRegistry } from "../methods/registry.js";
import { handleGatewayRequest } from "../server-methods.js";
import { createDispatchTestHarness } from "../server/ws-connection/authenticated-request-dispatch.test-support.js";
import { prepareGatewayOperatorIngressMetadata } from "../server/ws-connection/connect-device-metadata.js";
import { resetTestPluginRegistry, setTestPluginRegistry } from "../test-helpers.plugin-registry.js";
import { createControlUiHandlers } from "./control-ui.js";

const host = "microsoft.ghe.com";
let sharedState: OpenClawTestState | undefined;
afterAll(async () => {
  await sharedState?.cleanup();
});

async function withFixture(
  scope: Parameters<typeof createFixture>[0],
  run: (fixture: Awaited<ReturnType<typeof createFixture>>) => Promise<void>,
  useDefaultLoader = false,
) {
  sharedState ??= await createOpenClawTestState({ scenario: "minimal" });
  sharedState.applyEnv();
  const fixture = await createFixture(scope, useDefaultLoader);
  try {
    fixture.cfg.gateway = {
      ...fixture.cfg.gateway,
      github: { host, apiBaseUrl: `https://api.${host}` },
      projects: { nativeGitHubSearch: true },
    };
    setRuntimeConfigSnapshot(fixture.cfg);
    await linkCanonicalUserProfileEmail(`github:${host}:101`, fixture.profile.id);
    await run(fixture);
  } finally {
    await fixture.close();
    await fixture.removeSessions();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetTestPluginRegistry();
});

describe("registered Factory session GitHub preview", () => {
  it.each([
    { kind: "issue", bot: false, local: false },
    { kind: "pull", bot: false, local: false },
    { kind: "pull", bot: true, local: false },
    { kind: "issue", bot: false, local: true },
  ] as const)(
    "reads a literal Enterprise $kind using the selected credential (bot=$bot, local=$local)",
    async ({ kind, bot, local }) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      await withFixture("operator.read", async (f) => {
        // The admitted WebSocket fixture retains the actual registered client and current access grant.
        f.client.internal = {
          ...f.client.internal,
          ...prepareGatewayOperatorIngressMetadata({
            role: "operator",
            authMethod: "token",
            clientId: f.client.connect.client.id,
            scopes: f.client.connect.scopes ?? [],
          }),
        };
        f.client.authenticatedFactoryGitHubAccountId = 101;
        if (local) {
          f.cfg.gateway!.projects = {
            ...f.cfg.gateway!.projects,
            defaultRepository: { url: `https://${host}/bic/lobster.git` },
          };
          setRuntimeConfigSnapshot(f.cfg);
          await f.seed(sessionKey, f.profile.id, { lifecycleRevision: "preview-lifecycle" });
        } else {
          const repository = await getSessionRepositoryWorkspaceStore().create({
            agentId: "main",
            sessionKey,
            url: `https://${host}/bic/lobster.git`,
            branch: "preview-fixture",
            assertCurrent: () => {},
          });
          await f.seed(sessionKey, f.profile.id, {
            repositoryWorkspaceId: repository.workspaceId,
            lifecycleRevision: "preview-lifecycle",
          });
        }
        if (bot) {
          const profileId = "ghp_11111111111111111111111111111111";
          f.cfg.tools = { ...f.cfg.tools, github: { profileId } };
          setRuntimeConfigSnapshot(f.cfg);
          const directory = resolveManagedGitHubProfileDir({
            agentId: "main",
            scope: "system",
            profileId,
          });
          await fs.mkdir(directory, { recursive: true, mode: 0o700 });
          await fs.writeFile(
            path.join(directory, "hosts.yml"),
            `${host}:\n  oauth_token: synthetic-bot-reader\n`,
            { mode: 0o600 },
          );
          vi.spyOn(oauthLifecycle, "requestCurrentGitHubOAuthRefresh").mockResolvedValue();
        }
        const number = kind === "pull" ? 17420 : 17436;
        const url = `https://${host}/bic/lobster/${kind === "pull" ? "pull" : "issues"}/${number}`;
        const claims: FactoryGitHubProofVerdict[] = [];
        vi.spyOn(nativeIdentity, "readNativeGitHubToken").mockImplementation(async (env) => {
          expect(bot).toBe(false);
          expect(env?.GH_TOKEN).toBeUndefined();
          const claim = redeemFactoryGitHubProof(env?.[FACTORY_GITHUB_PROOF_ENV] ?? "");
          claims.push(claim);
          expect(claim).toMatchObject({
            actorId: 101,
            profileId: f.profile.id,
            purpose: "session-item-read",
            binding: {
              kind: "session",
              agentId: "main",
              sessionKey,
              sessionId: f.sessionId,
              lifecycleRevision: "preview-lifecycle",
              requestDigest: factoryGitHubRequestDigest(url),
            },
          });
          return "synthetic-reader-token";
        });
        vi.spyOn(oauth, "verifyGitHubCredential").mockResolvedValue({
          status: "available",
          scopes: [],
          account: { accountId: 101, login: "reader", avatarUrl: null },
        });
        const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
          const target = new URL(input instanceof Request ? input.url : String(input));
          expect(target.origin).toBe(`https://api.${host}`);
          expect(new Headers(init?.headers).get("authorization")).toBe(
            bot ? "Bearer synthetic-bot-reader" : "Bearer synthetic-reader-token",
          );
          const payload = target.pathname.endsWith("/commits")
            ? []
            : target.pathname === "/repos/bic/lobster"
              ? { full_name: "bic/lobster", private: true }
              : {
                  number,
                  title: "Synthetic private item",
                  body: "Synthetic fixture",
                  state: "closed",
                  html_url: url,
                  repository_url: `https://api.${host}/repos/bic/lobster`,
                  created_at: "2026-10-03T00:00:00Z",
                  updated_at: "2026-10-03T00:00:00Z",
                  user: { login: "reader" },
                  comments: 0,
                  base: {
                    repo: {
                      full_name: "bic/lobster",
                      url: `https://api.${host}/repos/bic/lobster`,
                    },
                  },
                };
          return new Response(JSON.stringify(payload), {
            headers: { "content-type": "application/json" },
          });
        });
        const handlers = createControlUiHandlers((target, identity) =>
          gitHubPublicApi.loadControlUiGitHubPreview(target, identity, fetchImpl),
        );
        const { default: github } = await loadBundledPluginFacade<{
          default: OpenClawPluginDefinition;
        }>({ pluginId: "github", artifactBasename: "index.ts" });
        const { registry, config } = createPluginRegistryFixture();
        registerVirtualTestPlugin({
          registry,
          config,
          id: "github",
          name: "GitHub",
          contracts: { gatewayMethodDispatch: ["authenticated-request"] },
          register: expectDefined(github.register, "GitHub registration"),
        });
        setTestPluginRegistry(registry.registry);
        const methods = createGatewayMethodRegistry(
          [
            ...registry.registry.gatewayMethodDescriptors,
            {
              name: "controlUi.githubPreview",
              owner: { kind: "core", area: "control-ui" },
              scope: "operator.read",
              profileAccess: "independent",
              handler: expectDefined(handlers["controlUi.githubPreview"], "preview handler"),
            },
          ],
          registry.registry,
        );
        f.context.getGatewayMethodRegistry = () => methods;
        const harness = createDispatchTestHarness({ buildRequestContext: () => f.context });
        harness.clients.add(f.client);
        await harness.dispatcher.dispatch(
          {
            type: "req",
            id: "factory-preview",
            method: "github.preview",
            params: { sessionKey, agentId: "main", url },
          },
          f.client,
        );
        const response = await harness.awaitResponseFrame("factory-preview");
        expect(response.error).toBeUndefined();
        expect(response).toMatchObject({
          ok: true,
          payload: { title: "Synthetic private item", url },
        });
        if (bot) {
          expect(claims).toHaveLength(0);
        } else {
          expect(claims.length).toBeGreaterThan(0);
        }
        expect(fetchImpl).toHaveBeenCalled();
      });
    },
  );

  it.each(["catalog", "checks", "foreign-checks"] as const)(
    "uses the same current reader for registered repository metadata: %s",
    async (method) => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      await withFixture(
        "operator.read",
        async (f) => {
          f.client.internal = {
            ...f.client.internal,
            ...prepareGatewayOperatorIngressMetadata({
              role: "operator",
              authMethod: "token",
              clientId: f.client.connect.client.id,
              scopes: f.client.connect.scopes ?? [],
            }),
          };
          f.client.authenticatedFactoryGitHubAccountId = 101;
          const repository = await getSessionRepositoryWorkspaceStore().create({
            agentId: "main",
            sessionKey,
            url: `https://${host}/bic/lobster.git`,
            branch: "preview-fixture",
            assertCurrent: () => {},
          });
          await f.seed(sessionKey, f.profile.id, {
            repositoryWorkspaceId: repository.workspaceId,
            lifecycleRevision: "metadata-lifecycle",
          });
          const claims: FactoryGitHubProofVerdict[] = [];
          const lookup = vi
            .spyOn(nativeIdentity, "readNativeGitHubToken")
            .mockImplementation(async (env) => {
              const claim = redeemFactoryGitHubProof(env?.[FACTORY_GITHUB_PROOF_ENV] ?? "");
              claims.push(claim);
              expect(claim).toMatchObject({
                purpose: "session-item-read",
                actorId: 101,
                profileId: f.profile.id,
                binding: {
                  kind: "session",
                  agentId: "main",
                  sessionKey,
                  sessionId: f.sessionId,
                  lifecycleRevision: "metadata-lifecycle",
                  requestDigest: factoryGitHubRequestDigest(`https://${host}/bic/lobster`),
                },
              });
              return "synthetic-reader-token";
            });
          vi.spyOn(oauth, "verifyGitHubCredential").mockResolvedValue({
            status: "available",
            scopes: [],
            account: { accountId: 101, login: "reader", avatarUrl: null },
          });
          const item = {
            number: 17420,
            title: "Synthetic PR",
            html_url: `https://${host}/bic/lobster/pull/17420`,
            state: "open",
            draft: false,
            merged_at: null,
            head: { sha: "a".repeat(40) },
            base: {
              ref: "main",
              repo: { name: "lobster", owner: { login: "bic" }, full_name: "bic/lobster" },
            },
          };
          const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
            const url = new URL(input instanceof Request ? input.url : String(input));
            expect(url.origin).toBe(`https://api.${host}`);
            expect(url.pathname.startsWith("/repos/bic/lobster")).toBe(true);
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer synthetic-reader-token",
            );
            const value = url.pathname.endsWith("/pulls")
              ? [item]
              : url.pathname.endsWith("/check-runs")
                ? { total_count: 0, check_runs: [] }
                : url.pathname.endsWith("/pulls/17420")
                  ? { ...item, additions: 0, deletions: 0, changed_files: 0 }
                  : { full_name: "bic/lobster", private: true };
            return new Response(JSON.stringify(value), {
              headers: { "content-type": "application/json" },
            });
          });
          vi.stubGlobal("fetch", fetchImpl);
          if (method === "catalog") {
            await f.subscribe();
            await f.subscriptions.pollNow();
            expect(f.load).not.toHaveBeenCalled();
            const payloads = f.socket.send.mock.calls.map(([bytes]) => JSON.parse(bytes));
            expect(payloads).toContainEqual(
              expect.objectContaining({
                event: "controlUi.sessionPullRequests.changed",
                payload: {
                  sessions: {
                    [sessionKey]: expect.objectContaining({
                      repository: { owner: "bic", repo: "lobster", host },
                      status: "ready",
                    }),
                  },
                },
              }),
            );
          } else {
            const respond = vi.fn();
            await handleGatewayRequest({
              req: {
                type: "req",
                id: "factory-checks",
                method: "controlUi.sessionPullRequests.checks",
                params: {
                  sessionKey,
                  owner: "bic",
                  repo: method === "foreign-checks" ? "other" : "lobster",
                  number: 17420,
                  headSha: "a".repeat(40),
                },
              },
              client: f.client,
              context: f.context,
              extraHandlers: createControlUiHandlers(),
              isWebchatConnect: () => false,
              respond,
            });
            if (method === "foreign-checks") {
              expect(respond.mock.calls[0]?.[0]).toBe(false);
              expect(lookup).not.toHaveBeenCalled();
              expect(fetchImpl).not.toHaveBeenCalled();
              return;
            }
            expect(respond.mock.calls[0]?.[0]).toBe(true);
            expect(respond.mock.calls[0]?.[1]).toMatchObject({
              owner: "bic",
              repo: "lobster",
              number: 17420,
              status: "ready",
              checks: [],
            });
          }
          expect(claims.length).toBeGreaterThan(0);
          expect(fetchImpl).toHaveBeenCalled();
        },
        true,
      );
    },
  );

  it.each([
    "foreign-repository",
    "foreign-local-repository",
    "foreign-host",
    "missing-identity",
    "actor-changed",
    "host-changed",
    "unredeemed-proof",
    "missing-credential",
    "grant",
    "cancelled",
    "visibility",
    "reselected",
  ] as const)("does not deliver or borrow another identity after %s", async (change) => {
    vi.stubEnv("FACTORY_AUTH_MODE", "github");
    await withFixture("operator.read", async (f) => {
      // The admitted WebSocket fixture retains the actual registered client and current access grant.
      f.client.internal = {
        ...f.client.internal,
        ...prepareGatewayOperatorIngressMetadata({
          role: "operator",
          authMethod: "token",
          clientId: f.client.connect.client.id,
          scopes: f.client.connect.scopes ?? [],
        }),
      };
      if (change !== "missing-identity") {
        f.client.authenticatedFactoryGitHubAccountId = 101;
      }
      const local = change === "foreign-local-repository";
      if (local) {
        f.cfg.gateway!.projects = {
          ...f.cfg.gateway!.projects,
          defaultRepository: { url: `https://${host}/bic/lobster.git` },
        };
        setRuntimeConfigSnapshot(f.cfg);
        await f.seed(sessionKey, f.profile.id);
      }
      const repository = local
        ? undefined
        : await getSessionRepositoryWorkspaceStore().create({
            agentId: "main",
            sessionKey,
            url: `https://${host}/bic/lobster.git`,
            branch: "preview-fixture",
            assertCurrent: () => {},
          });
      if (repository) {
        await f.seed(sessionKey, f.profile.id, { repositoryWorkspaceId: repository.workspaceId });
      }
      const lookup = vi
        .spyOn(nativeIdentity, "readNativeGitHubToken")
        .mockImplementation(async (env) => {
          if (change !== "unredeemed-proof") {
            redeemFactoryGitHubProof(env?.[FACTORY_GITHUB_PROOF_ENV] ?? "");
          }
          return change === "missing-credential" ? undefined : "synthetic-reader-token";
        });
      vi.spyOn(oauth, "verifyGitHubCredential").mockImplementation(async () => {
        if (change === "actor-changed") {
          f.client.authenticatedFactoryGitHubAccountId = 202;
        }
        if (change === "host-changed") {
          setRuntimeConfigSnapshot({
            ...f.cfg,
            gateway: { ...f.cfg.gateway, github: { host: "github.com" } },
          });
        }
        return {
          status: "available",
          scopes: [],
          account: { accountId: 101, login: "reader", avatarUrl: null },
        };
      });
      const load = vi.fn<NonNullable<Parameters<typeof createControlUiHandlers>[0]>>(
        async (_target, identity) => {
          expect(identity?.token).toBe("synthetic-reader-token");
          if (change === "grant" || change === "visibility") {
            await f.changeReader(change);
          }
          if (change === "cancelled") {
            await f.changeReader("connection");
          }
          if (change === "reselected") {
            await f.seed(sessionKey, f.profile.id, {
              repositoryWorkspaceId: repository?.workspaceId,
              sessionId: "replacement-session",
              lifecycleRevision: "replacement",
            });
          }
          return { title: "Do not deliver this late private item", number: 17420 };
        },
      );
      const respond = vi.fn();
      await handleGatewayRequest({
        req: {
          type: "req",
          id: "factory-preview-denied",
          method: "controlUi.githubPreview",
          params: {
            sessionKey,
            agentId: "main",
            kind: "pull",
            owner: "bic",
            repo: change === "foreign-repository" || local ? "other" : "lobster",
            ...(change === "foreign-host" ? { githubHost: "github.com" } : {}),
            number: 17420,
          },
        },
        client: f.client,
        context: f.context,
        extraHandlers: createControlUiHandlers(load),
        isWebchatConnect: () => false,
        respond,
      });
      expect(respond.mock.calls[0]?.[0]).toBe(false);
      expect(respond.mock.calls[0]?.[1]).toBeUndefined();
      if (
        [
          "foreign-repository",
          "foreign-local-repository",
          "foreign-host",
          "missing-identity",
        ].includes(change)
      ) {
        expect(lookup).not.toHaveBeenCalled();
      }
      if (
        [
          "foreign-repository",
          "foreign-local-repository",
          "foreign-host",
          "missing-identity",
          "actor-changed",
          "host-changed",
          "unredeemed-proof",
          "missing-credential",
        ].includes(change)
      ) {
        expect(load).not.toHaveBeenCalled();
      }
    });
  });
});
