import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type {
  BoardSnapshot,
  BoardWidgetPutResult,
  HelloOk,
  UsersSelfResult,
} from "../../packages/gateway-protocol/src/index.js";
import { waitForGatewayStartup } from "../../test/helpers/gateway-startup.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getRuntimeConfig, writeConfigFile } from "../config/config.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { gitHubPublicApi } from "./github-public-api.js";
import * as gateway from "./server.auth.test-helpers.js";

gateway.installGatewayTestHooks({ scope: "suite" });
const temps = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

test("keeps manual WebSocket calls within a session reader's approved named query", async () => {
  const ownerEmail = "query-owner@example.test";
  const readerEmail = "query-reader@example.test";
  const agentToken = "synthetic-agent-actions-token";
  vi.stubEnv("GH_TOKEN", agentToken);
  vi.stubEnv("GITHUB_TOKEN", undefined);
  // The Gateway harness isolates plugins; this flow needs GitHub's real public API surface.
  vi.stubEnv("OPENCLAW_DISABLE_BUNDLED_PLUGINS", undefined);
  vi.stubEnv("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
  // Load the source plugin before opening sockets and starting handshake deadlines.
  const githubOrigin = gitHubPublicApi.GITHUB_API_ORIGIN;
  await gateway.configureBrowserAuth(
    gateway.browserProxyAuth({
      identityScopes: {
        [ownerEmail]: ["operator.admin"],
        [readerEmail]: ["operator.sessions.read"],
      },
    }),
    {
      roles: {
        default: "reader",
        definitions: {
          reader: {
            scopes: ["operator.sessions.read"],
            agents: ["main"],
            sessions: { others: "view" },
          },
          owner: { scopes: ["operator.admin"], agents: ["main"], sessions: { others: "write" } },
        },
      },
    },
  );
  const cfg = getRuntimeConfig();
  await writeConfigFile({
    ...cfg,
    tools: { ...cfg.tools, exec: { ...cfg.tools?.exec, mode: "ask" } },
  });
  const ownerProfile = ensureProfileForEmail(ownerEmail);
  setUserProfileRole(ownerProfile.id, "owner");
  const upstream: { url: string; authorization: string | null }[] = [];
  const originalFetch = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith(`${githubOrigin}/`)) {
      return await originalFetch(input, init);
    }
    upstream.push({ url, authorization: new Headers(init?.headers).get("authorization") });
    return url.endsWith("/user")
      ? Response.json({ id: 100, login: "agent-account", avatar_url: null })
      : Response.json({
          total_count: 1,
          workflow_runs: [
            {
              id: 4242,
              name: "CI",
              display_title: "Private title",
              head_branch: "main",
              status: "completed",
              conclusion: "success",
              html_url: "https://github.com/owner/repo/actions/runs/4242",
              run_started_at: "2026-10-27T00:00:00Z",
              created_at: "2026-10-27T00:00:00Z",
              updated_at: "2026-10-27T00:01:00Z",
              event: "push",
              workflow_id: 17,
              run_attempt: 1,
            },
          ],
        });
  });
  await gateway.withGatewayServer(
    async ({ port }) => {
      await waitForGatewayStartup(port);
      const target = { agentId: "main", sessionKey: "agent:main:ws-named-query" };
      await upsertSessionEntryCore(target, {
        sessionId: "ws-named-query",
        updatedAt: Date.now(),
        visibility: "shared",
        createdActor: { type: "human", source: "profile", id: ownerProfile.id },
      });
      async function connect(email: string, scopes: string[]) {
        const ws = await gateway.openWs(port, {
          ...gateway.TRUSTED_BROWSER_HEADERS,
          "x-forwarded-user": email,
        });
        try {
          const connected = await gateway.connectReq(ws, {
            prePairDevice: true,
            client: gateway.CONTROL_UI_CLIENT,
            browserOrigin: gateway.BROWSER_ORIGIN,
            skipDefaultAuth: true,
            scopes,
            deviceIdentityPath: path.join(
              temps.make("query-browser-"),
              "client",
              "credentials.sqlite",
            ),
          });
          expect(connected.ok, JSON.stringify(connected.error)).toBe(true);
          return { ws, hello: connected.payload as HelloOk, [Symbol.dispose]: () => ws.close() };
        } catch (error) {
          ws.close();
          throw error;
        }
      }
      using owner = await connect(ownerEmail, ["operator.admin"]);
      using reader = await connect(readerEmail, ["operator.read", "operator.sessions.read"]);
      expect(reader.hello.auth?.scopes).toEqual(["operator.sessions.read"]);
      const readerSelf = await gateway.rpcReq<UsersSelfResult>(reader.ws, "users.self", {});
      expect(readerSelf.ok).toBe(true);
      expect(readerSelf.payload?.profile.id).not.toBe(ownerProfile.id);
      const saved = await gateway.rpcReq<BoardWidgetPutResult>(owner.ws, "board.widget.put", {
        ...target,
        name: "ci",
        content: { kind: "html", html: "<p>CI</p>" },
        declared: {
          queries: [
            {
              name: "main-ci",
              bindingId: "github.actions.runs",
              params: {
                repository: "owner/repo",
                workflow: "ci.yml",
                branch: "main",
                status: null,
                created: null,
                perPage: 1,
                excludePullRequests: true,
              },
              fields: ["id"],
            },
          ],
        },
      });
      expect(saved.ok, JSON.stringify(saved.error)).toBe(true);
      const widget = saved.payload!.widgets[0]!;
      expect(widget.grantState).toBe("pending");
      expect(
        await gateway.rpcReq(owner.ws, "board.widget.grant", {
          ...target,
          name: "ci",
          decision: "granted",
          revision: widget.revision,
          instanceId: widget.instanceId,
        }),
      ).toMatchObject({ ok: true });
      const board = await gateway.rpcReq<BoardSnapshot>(reader.ws, "board.get", target);
      expect(board.ok, JSON.stringify(board.error)).toBe(true);
      const ticket = board.payload!.widgets[0]!.viewTicket;
      expect(ticket).toBeTypeOf("string");
      const data = await gateway.rpcReq(reader.ws, "board.data.read", {
        ticket,
        queryName: "main-ci",
      });
      expect(data.ok, JSON.stringify(data.error)).toBe(true);
      expect(data.payload).toEqual({ workflow_runs: [{ id: 4242 }] });
      for (const request of [
        { ticket, queryName: "main-ci", params: { branch: "release", perPage: 30 } },
        {
          ticket,
          bindingId: "github.actions.runs",
          params: { repository: "owner/repo", branch: "release" },
        },
      ]) {
        const denied = await gateway.rpcReq(reader.ws, "board.data.read", request);
        expect(denied).toMatchObject({ ok: false, error: { message: expect.any(String) } });
        expect(denied.payload).toBeUndefined();
      }
      expect(upstream.filter(({ url }) => url.includes("/actions/"))).toEqual([
        {
          url: "https://api.github.com/repos/owner/repo/actions/workflows/ci.yml/runs?per_page=1&exclude_pull_requests=true&branch=main",
          authorization: `Bearer ${agentToken}`,
        },
      ]);
    },
    { serverOptions: { sidecarStartup: "defer", controlUiEnabled: false } },
  );
});
