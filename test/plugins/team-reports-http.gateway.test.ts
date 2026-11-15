import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTeamReportsHttpHandler,
  createTeamReportsStore,
  listWorkSessions,
} from "../../extensions/team-reports/api.js";
import { upsertSessionEntryCore } from "../../src/config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { ResolvedGatewayAuth } from "../../src/gateway/auth.js";
import { CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS } from "../../src/gateway/control-ui-contract.js";
import { setControlUiPluginAuthCookie } from "../../src/gateway/control-ui-plugin-auth-cookie.js";
import { resolveControlUiPluginAuthCookieGeneration } from "../../src/gateway/http-auth-plugin-cookie.js";
import { invalidateOperatorRolePolicy } from "../../src/gateway/operator-role-policy.js";
import { createDirectChatContext } from "../../src/gateway/server-chat.agent-events.test-helpers.js";
import { createTestGatewayServer } from "../../src/gateway/server-http.test-harness.js";
import { createGatewayTestRegistry } from "../../src/gateway/server/__tests__/test-utils.js";
import { createGatewayPluginRequestHandler } from "../../src/gateway/server/plugins-http.js";
import { resolveSharedGatewaySessionGeneration } from "../../src/gateway/server/ws-shared-generation.js";
import { bindSessionRowProjection } from "../../src/gateway/session-row-projection-access.js";
import { createSessionRowProjection } from "../../src/gateway/session-row-projection.js";
import { withTempConfig } from "../../src/gateway/test-temp-config.js";
import { resolveRuntimeWorkerUrl } from "../../src/infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../src/logging/subsystem.js";
import { sessionChanges } from "../../src/sessions/session-row-changes.js";
import {
  setUserProfileRole,
  syncGitHubIdentity,
} from "../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";
import { closeHttpServer, listenLoopback } from "../helpers/gateway-integration-fixtures.js";
import { createDeferred, withTestTimeout } from "../helpers/promise.js";

const reportRoute = { pluginId: "team-reports", path: "/reports", match: "prefix" as const };

async function get(baseUrl: string, path: string, cookie?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return {
    status: response.status,
    body: await response.text(),
    cookies: response.headers.getSetCookie(),
  };
}

function expectReport(response: Awaited<ReturnType<typeof get>>, visible: string, hidden: RegExp) {
  expect(response).toMatchObject({
    status: 200,
    body: expect.stringContaining(`REPORT-PROOF-${visible}`),
  });
  expect(response.body).not.toMatch(hidden);
}

async function withReports(
  roles: boolean,
  run: (fixture: {
    read: (path?: string) => ReturnType<typeof get>;
    blockDiscovery: () => { entered: Promise<void>; release: () => void };
    rotate: () => void;
    expire: () => void;
    blockViewer: () => void;
    blockViewerAfterDiscovery: () => void;
  }) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const cfg: OpenClawConfig = { agents: { entries: { main: {} } } };
    if (roles) {
      cfg.gateway = {
        roles: {
          default: "blocked",
          definitions: {
            reader: { agents: "*", scopes: ["operator.read"], sessions: { others: "view" } },
            blocked: { agents: "*", scopes: ["operator.read"], sessions: { others: "none" } },
          },
        },
      };
    }
    await withTempConfig({
      cfg,
      run: async () => {
        const reader = ensureProfileForEmail("reports-reader@example.test");
        const owner = syncGitHubIdentity({
          identity: { accountId: 101, login: "owner-alias" },
          authenticationAlias: { kind: "email", email: "reports-owner@example.test" },
        });
        syncGitHubIdentity({
          identity: { accountId: 102, login: "reader" },
          authenticationAlias: { kind: "email", email: "reports-reader@example.test" },
        });
        setUserProfileRole(reader.id, "reader");
        const seed = (
          name: string,
          profileId = owner.id,
          entry: Parameters<typeof upsertSessionEntryCore>[1] = {},
        ) =>
          upsertSessionEntryCore(
            { agentId: "main", sessionKey: "agent:main:" + name },
            {
              sessionId: name,
              label: "REPORT-PROOF-" + name,
              updatedAt: Date.now(),
              // Metadata upserts clamp updatedAt to now; activity paging uses its own durable clock.
              lastActivityAt: name === "shared" ? 1 : name === "own-draft" ? 100 : 50,
              visibility: "shared",
              createdActor: { type: "human", source: "profile", id: profileId },
              ...entry,
            },
          );
        await seed("own-draft", reader.id, { visibility: "draft" });
        await seed("foreign-draft", owner.id, { visibility: "draft" });
        await seed("shared");
        for (let i = 0; i < 45; i++) {
          await seed(`newer-${i}`, reader.id);
        }
        await seed("archived", owner.id, { archivedAt: 1 });
        await seed("cron:excluded:run:one");
        await seed("dashboard:incognito-reports", reader.id, { incognito: true });
        const context = createDirectChatContext({ getRuntimeConfig: () => cfg });
        let gate: ReturnType<typeof createDeferred<void>> | undefined;
        let entered: ReturnType<typeof createDeferred<void>> | undefined;
        const projection = await createSessionRowProjection({
          cfg,
          context,
          getModelCatalog: async () => {
            entered?.resolve();
            await gate?.promise;
            return undefined;
          },
        });
        bindSessionRowProjection(context, () => projection);
        const store = await createTeamReportsStore({
          workerModuleUrl: resolveRuntimeWorkerUrl({
            currentModuleUrl: import.meta.url,
            sourceWorkerName: "../../extensions/team-reports/src/store.worker",
            distWorkerPath: "extensions/team-reports/src/store.worker.js",
          }),
        });
        let auth: ResolvedGatewayAuth = {
          mode: "token",
          token: "reports-proof-initial",
          allowTailscale: false,
        };
        const issuedAt = Date.now();
        let discoveryStarted: ReturnType<typeof createDeferred<void>> | undefined;
        let withdrawAfterDiscovery = false;
        const blockViewer = () => {
          setUserProfileRole(reader.id, "blocked");
          // Match users.setRole: publish the committed assignment to the auth cache.
          invalidateOperatorRolePolicy(reader.id);
        };
        const handler = createGatewayPluginRequestHandler({
          registry: createGatewayTestRegistry({
            httpRoutes: [
              {
                ...reportRoute,
                auth: "gateway",
                gatewayMethodDispatchAllowed: true,
                handler: createTeamReportsHttpHandler({
                  basePath: "/reports",
                  displayTimezone: "UTC",
                  assetsDir: "unused",
                  sessionRouting: () => ({ controlUiBasePath: "", mainKey: "main" }),
                  workSessions: async (offset, limit, profileId) => {
                    discoveryStarted?.resolve();
                    const sessions = await listWorkSessions(offset, limit, profileId);
                    if (withdrawAfterDiscovery) {
                      withdrawAfterDiscovery = false;
                      blockViewer();
                    }
                    return sessions;
                  },
                  getStore: () => store,
                  status: async () => ({}),
                  health: async () => ({ running: false, warnings: 0 }),
                  orgs: () => [],
                  people: () => [{ github: ["owner", "OWNER-ALIAS"] }, { github: ["reader"] }],
                }),
                source: "reports-proof",
              },
            ],
          }),
          getGatewayRequestContext: () => context,
          log: createSubsystemLogger("test/reports-http"),
        });
        const server = createTestGatewayServer({
          resolvedAuth: auth,
          overrides: {
            getResolvedAuth: () => auth,
            getRuntimeConfig: () => cfg,
            getGatewayRequestContext: () => context,
            handlePluginRequest: handler,
            shouldEnforcePluginGatewayAuth: () => true,
            handleHooksRequest: async (req, res) => {
              // The fixture issues synthetic identity cookies through the real signer.
              if (req.url !== "/fixture-cookie") {
                return false;
              }
              setControlUiPluginAuthCookie(res, [{ ...reportRoute, scopes: ["operator.read"] }], {
                generation: resolveControlUiPluginAuthCookieGeneration(
                  resolveSharedGatewaySessionGeneration(auth),
                  cfg,
                ),
                profileId: reader.id,
                nowMs: issuedAt,
              });
              res.end();
              return true;
            },
          },
        });
        try {
          await projection.ensureMaterialized();
          const baseUrl = await listenLoopback(server);
          const issued = await get(baseUrl, "/fixture-cookie");
          expect(issued.cookies).toHaveLength(1);
          const cookie = issued.cookies.map((value) => value.split(";", 1)[0]).join("; ");
          await run({
            read: (path = "/reports/sessions/") => get(baseUrl, path, cookie),
            blockDiscovery: () => {
              gate = createDeferred();
              entered = createDeferred();
              discoveryStarted = createDeferred();
              sessionChanges.emit({ all: true, scope: "catalog" });
              return {
                entered: Promise.all([entered.promise, discoveryStarted.promise]).then(() => {}),
                release: () => gate?.resolve(),
              };
            },
            rotate: () => {
              auth = { ...auth, token: "reports-proof-rotated" };
            },
            expire: () => {
              vi.spyOn(Date, "now").mockReturnValue(issuedAt + CONTROL_UI_PLUGIN_AUTH_GRANT_TTL_MS);
            },
            blockViewer,
            blockViewerAfterDiscovery: () => {
              withdrawAfterDiscovery = true;
            },
          });
        } finally {
          gate?.resolve();
          if (server.listening) {
            await closeHttpServer(server);
          }
          await projection.ensureMaterialized();
          projection.dispose();
          await store.close();
        }
      },
    });
  });
}

describe("Reports HTTP disclosure with production cookie auth and sessions.list", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });
  it.each([false, true])(
    "renders only the signed viewer's visible sessions (roles=%s)",
    async (roles) => {
      await withReports(roles, async ({ read, blockViewer }) => {
        for (const path of ["/reports/", "/reports/sessions/"]) {
          expectReport(
            await read(path),
            "own-draft",
            /REPORT-PROOF-(shared|foreign-draft|dashboard:incognito-reports)/,
          );
        }
        for (const path of ["/reports/people/owner/", "/reports/sessions/?person=OWNER-ALIAS"]) {
          expectReport(
            await read(path),
            "shared",
            /REPORT-PROOF-(foreign-draft|own-draft|archived|cron:)/,
          );
        }
        const own = await read("/reports/people/reader/");
        expect(own.body).not.toContain("REPORT-PROOF-dashboard:incognito-reports");
        if (roles) {
          blockViewer();
          const owned = await read("/reports/people/owner/");
          expect(owned.body).not.toContain("REPORT-PROOF-shared");
          expect(owned.body).toContain("No work sessions are visible to you.");
          expectReport(await read(), "own-draft", /REPORT-PROOF-shared/);
        }
      });
    },
  );
  it.each(["role", "expiry", "generation"] as const)(
    "does not disclose when %s authority changes before HTTP delivery",
    async (invalidation) => {
      await withReports(invalidation === "role", async (fixture) => {
        if (invalidation === "role") {
          fixture.blockViewerAfterDiscovery();
        }
        const gate = invalidation === "role" ? undefined : fixture.blockDiscovery();
        const pending = fixture.read("/reports/people/owner/");
        try {
          if (gate) {
            await withTestTimeout(
              gate.entered,
              10_000,
              "sessions.list did not enter delayed discovery",
            );
            if (invalidation === "expiry") {
              fixture.expire();
            } else {
              fixture.rotate();
            }
            gate.release();
          }
          const response = await pending;
          expect(response.body).not.toContain(
            invalidation === "role" ? "REPORT-PROOF-shared" : "REPORT-PROOF-",
          );
          expect(response.status).toBe(401);
        } finally {
          gate?.release();
          await pending;
        }
      });
    },
  );
});
