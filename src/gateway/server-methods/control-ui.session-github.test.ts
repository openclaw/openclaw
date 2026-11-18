import { generateKeyPairSync } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { sha256Hex } from "@openclaw/normalization-core/node-crypto";
import { afterEach, expect, it, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { getSessionRepositoryWorkspaceStore } from "../../state/session-repository-workspaces.js";
import { linkEmail } from "../../state/user-profile-writes.worker.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createFixture, sessionKey } from "../control-ui-session-pr-access.test-support.js";
import {
  redeemFactoryGitHubProof,
  type FactoryGitHubProofVerdict,
} from "../factory-github-proof.js";
import { handleGatewayRequest } from "../server-methods.js";

const host = "engineering.ghe.com";
const apiBaseUrl = "https://api.engineering.ghe.com";
const targetUrl = `https://${host}/example/project/pull/7`;
const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
  type: "pkcs8",
  format: "pem",
});
const permissions = { contents: "write" as const, metadata: "read" as const };
const time = "2026-10-10T10:00:00Z";
const repo = { id: 404, fullName: "example/project" };
const apiRepo = { id: repo.id, full_name: repo.fullName };
const target = { owner: "example", repo: "project", number: 7 };
const preview = { ...target, title: "Private session pull request" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it.each([
  "allowed",
  "multiple-repositories",
  "admission-denied",
  "foreign-repository",
  "foreign-host",
  "retired",
  "actor-mismatch",
  "cleanup-failure",
  "actor-rebound-during-cleanup",
] as const)(
  "reads Enterprise previews only through the current session and selected App (%s)",
  async (scenario) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      vi.stubEnv("FACTORY_AUTH_MODE", "github");
      vi.stubEnv("OPENCLAW_GATEWAY_PASSWORD", "synthetic-broker-password");
      const f = await createFixture("operator.read", true);
      try {
        linkEmail("github:engineering.ghe.com:50", f.profile.id);
        f.client.authenticatedFactoryGitHubAccountId = scenario === "actor-mismatch" ? 51 : 50;
        f.client.authenticatedUserId = `github:${host}:${f.client.authenticatedFactoryGitHubAccountId}`;
        f.client.internal = { ...f.client.internal, authenticatedOperator: true };
        setRuntimeConfigSnapshot({
          ...f.cfg,
          gateway: { ...f.cfg.gateway, github: { host, apiBaseUrl } },
          tools: {
            github: {
              kind: "app-installation" as const,
              profileId: "ghp_00000000000000000000000000000001",
              app: {
                appId: 101,
                installationId: 202,
                accountId: 303,
                repositories: [
                  repo,
                  ...(scenario === "multiple-repositories"
                    ? [{ id: 405, fullName: "example/other" }]
                    : []),
                ],
                permissions,
                privateKey,
                keyVersion: "synthetic-v1",
              },
            },
          },
        });
        const repository = await getSessionRepositoryWorkspaceStore().create({
          agentId: "main",
          sessionKey,
          url: `https://${host}/example/project`,
          branch: "synthetic",
          assertCurrent() {},
        });
        await f.seed(sessionKey, f.profile.id, {
          repositoryWorkspaceId: repository.workspaceId,
          lifecycleRevision: "synthetic-lifecycle",
        });
        const claims: FactoryGitHubProofVerdict[] = [];
        const requests: string[] = [];
        const fetcher = vi.fn<typeof fetch>(async (input, init) => {
          const url = new URL(input instanceof Request ? input.url : String(input));
          requests.push(url.origin + url.pathname);
          if (url.origin === "http://127.0.0.1:8080") {
            const proof = expectDefined(
              new Headers(init?.headers).get("x-factory-github-proof"),
              "fixture broker proof",
            );
            const claim = redeemFactoryGitHubProof(proof);
            claims.push(claim);
            if (scenario === "admission-denied") {
              return new Response(null, { status: 403 });
            }
            return Response.json({
              version: 1,
              kind: "repository-admission",
              host,
              appId: 101,
              installationId: 202,
              repository: repo,
              actor: { accountId: claim.actorId, profileId: claim.profileId },
              purpose: claim.purpose,
              binding: claim.binding,
              expiresAtMs: Date.now() + 60_000,
            });
          }
          expect(url.origin).toBe(apiBaseUrl);
          if (init?.method === "DELETE") {
            if (scenario === "actor-rebound-during-cleanup") {
              linkEmail(`github:${host}:50`, f.other.id);
            }
            return new Response(null, { status: scenario === "cleanup-failure" ? 500 : 204 });
          }
          const bodies: Record<string, unknown> = {
            "/app": { id: 101, slug: "x", permissions },
            "/app/installations/202": {
              id: 202,
              app_id: 101,
              account: { id: 303 },
              suspended_at: null,
              permissions,
            },
            "/users/x%5Bbot%5D": { id: 9001, login: "x[bot]", type: "Bot", avatar_url: null },
            "/installation/repositories": {
              total_count: 1,
              repositories: [apiRepo],
            },
            "/repos/example/project": {
              ...apiRepo,
              private: true,
              visibility: "private",
            },
            "/repos/example/project/pulls/7/commits": [],
          };
          if (url.pathname.endsWith("/access_tokens")) {
            if (typeof init?.body !== "string") {
              throw new Error("App token request body must be JSON text");
            }
            expect(JSON.parse(init.body)).toEqual({ repository_ids: [404], permissions });
            return Response.json({
              token: "synthetic-preview-app-token",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              permissions,
            });
          }
          if (url.pathname === "/repos/example/project/pulls/7") {
            expect(new Headers(init?.headers).get("authorization")).toBe(
              "Bearer synthetic-preview-app-token",
            );
            if (scenario === "retired") {
              await f.changeReader("grant");
            }
            return Response.json({
              title: preview.title,
              state: "open",
              created_at: time,
              updated_at: time,
              base: { repo: { url: `${apiBaseUrl}/repos/example/project` } },
            });
          }
          return Response.json(expectDefined(bodies[url.pathname], `endpoint ${url.pathname}`));
        });
        vi.stubGlobal("fetch", fetcher);
        const params = {
          kind: "pull",
          ...target,
          repo: scenario === "foreign-repository" ? "other" : "project",
          githubHost: scenario === "foreign-host" ? "other.example.test" : host,
          sessionKey,
          agentId: "main",
        };
        const respond = vi.fn();
        await handleGatewayRequest({
          req: { id: "private-preview", type: "req", method: "controlUi.githubPreview", params },
          context: f.context,
          client: f.client,
          isWebchatConnect: () => false,
          respond,
        });
        if (scenario === "allowed" || scenario === "multiple-repositories") {
          expect(respond).toHaveBeenCalledExactlyOnceWith(
            true,
            expect.objectContaining(preview),
            undefined,
          );
          expect(claims).toHaveLength(1);
          expect(claims[0]).toMatchObject({
            actorId: 50,
            profileId: f.profile.id,
            purpose: "session-item-read",
            binding: {
              kind: "session",
              agentId: "main",
              sessionKey,
              sessionId: f.sessionId,
              lifecycleRevision: "synthetic-lifecycle",
              requestDigest: sha256Hex(targetUrl),
            },
          });
          expect(requests.at(-1)).toBe(`${apiBaseUrl}/installation/token`);
        } else {
          expect(respond.mock.calls.map((args) => args.slice(0, 2))).toEqual([[false, undefined]]);
          if (["foreign-repository", "foreign-host", "actor-mismatch"].includes(scenario)) {
            expect(fetcher).not.toHaveBeenCalled();
          }
          if (scenario === "admission-denied") {
            expect(requests).toEqual([
              "http://127.0.0.1:8080/__factory__/github/repository-admission",
            ]);
          }
        }
        expect(
          requests.some((url) => url.startsWith("https://api.github.com") || url.endsWith("/user")),
        ).toBe(false);
      } finally {
        await f.close();
      }
    });
  },
);
