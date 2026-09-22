// Read-only Doctor must not rotate a server credential into a discarded database.
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBundleMcpToolRuntime } from "../agents/agent-bundle-mcp-tools.js";
import { operatorMcpOAuthIdentity } from "../agents/mcp-oauth-identity.js";
import { createMcpOAuthClientProvider } from "../agents/mcp-oauth-provider.js";
import { readMcpOAuthStoreReadOnly } from "../agents/mcp-oauth-store.js";
import { createCoreHealthChecks } from "../flows/doctor-core-checks.js";
import { clearHealthChecksForTest } from "../flows/health-check-registry.js";
import { closeOpenClawStateDatabaseByPath } from "../state/openclaw-state-db-cache.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectDoctorFindings, runDoctorLintCli } from "./doctor-lint.js";
import { snapshotDoctorLintSqliteFamily } from "./doctor-lint.test-support.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const mocks = vi.hoisted(() => ({ fetch: vi.fn<FetchLike>() }));

vi.mock("../flows/doctor-health-contributions.js", () => ({
  resolveDoctorContributionHealthChecks: async () =>
    createCoreHealthChecks().filter((check) => check.id === "core/doctor/runtime-tool-schemas"),
}));
vi.mock("../agents/prepared-model-catalog.js", () => ({
  readPreparedModelCatalog: async () => [],
}));
vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: () => [],
}));
vi.mock("../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: () => [],
  normalizeProviderToolSchemasWithPlugin: ({ context }: { context: { tools: unknown[] } }) =>
    context.tools,
}));
vi.mock("../agents/mcp-http-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/mcp-http-fetch.js")>()),
  buildMcpHttpFetch: () => mocks.fetch,
}));

const ISSUER = "https://oauth.example.test";
const SERVER_URL = `${ISSUER}/mcp`;
const SERVER_NAME = "rotation-proof";
const IDENTITY = operatorMcpOAuthIdentity(SERVER_NAME, SERVER_URL);

function rotatingOAuthServer(rejectStoredAccess: boolean) {
  let refreshes = 0;
  let replayDetected = false;
  const fetch: FetchLike = async (input, init) => {
    const request = new Request(input instanceof Request ? input.clone() : input, init);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      return Response.json({ resource: SERVER_URL, authorization_servers: [ISSUER] });
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      return Response.json({
        issuer: ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/token`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
      });
    }
    if (url.pathname === "/token") {
      const body = new URLSearchParams(await request.text());
      expect(body.get("grant_type")).toBe("refresh_token");
      if (body.get("refresh_token") !== `fixture-refresh-${refreshes}`) {
        replayDetected = true;
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      refreshes += 1;
      return Response.json({
        access_token: `fixture-access-${refreshes}`,
        refresh_token: `fixture-refresh-${refreshes}`,
        token_type: "Bearer",
        expires_in: 3600,
      });
    }
    if (url.pathname === "/mcp") {
      const bearer = request.headers.get("authorization");
      if (
        bearer !== `Bearer fixture-access-${refreshes}` ||
        (rejectStoredAccess && refreshes === 0)
      ) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${ISSUER}/.well-known/oauth-protected-resource"`,
          },
        });
      }
      if (request.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      const message = (await request.json()) as { id?: number; method: string };
      if (message.id === undefined) {
        return new Response(null, { status: 202 });
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: "2025-03-26",
              capabilities: { tools: {} },
              serverInfo: { name: "rotation-proof", version: "1" },
            }
          : {
              tools: [{ name: "status", inputSchema: { type: "object", properties: {} } }],
            };
      return Response.json({ jsonrpc: "2.0", id: message.id, result });
    }
    return new Response(null, { status: 404 });
  };
  return {
    fetch,
    get refreshes() {
      return refreshes;
    },
    get replayDetected() {
      return replayDetected;
    },
  };
}

describe("Doctor OAuth snapshot isolation", () => {
  beforeEach(() => {
    clearHealthChecksForTest();
    mocks.fetch.mockReset();
  });
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.restoreAllMocks();
  });

  it.each([
    { lane: "lint", rejected: false },
    { lane: "triage", rejected: true },
  ] as const)(
    "$lane leaves server refresh authority for the live owner",
    async ({ lane, rejected }) => {
      await withOpenClawTestState({ prefix: "openclaw-doctor-oauth-" }, async (state) => {
        const cfg = {
          agents: { entries: { main: { default: true, workspace: state.workspaceDir } } },
          mcp: {
            servers: {
              [SERVER_NAME]: {
                transport: "streamable-http" as const,
                url: SERVER_URL,
                auth: "oauth" as const,
              },
            },
          },
        };
        await state.writeConfig(cfg);
        const network = rotatingOAuthServer(rejected);
        mocks.fetch.mockImplementation(network.fetch);
        const provider = createMcpOAuthClientProvider({ identity: IDENTITY });
        await provider.saveClientInformation?.({ client_id: "fixture-client" });
        await provider.saveDiscoveryState?.({ authorizationServerUrl: ISSUER });
        await provider.saveTokens({
          access_token: "fixture-access-0",
          refresh_token: "fixture-refresh-0",
          token_type: "Bearer",
          expires_in: rejected ? 3600 : -1,
        });
        const databasePath = resolveOpenClawStateSqlitePath(process.env);
        closeOpenClawStateDatabaseByPath(databasePath);
        const before = snapshotDoctorLintSqliteFamily(databasePath);
        const runtime = createTestRuntime();
        const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
        const findings =
          lane === "triage"
            ? await collectDoctorFindings(runtime)
            : await (async () => {
                await runDoctorLintCli(runtime, {
                  json: true,
                  severityMin: "info",
                  onlyIds: ["core/doctor/runtime-tool-schemas"],
                });
                return JSON.parse(String(stdout.mock.calls.at(-1)?.[0])).findings;
              })();
        stdout.mockRestore();
        expect(snapshotDoctorLintSqliteFamily(databasePath)).toEqual(before);
        expect(network.refreshes).toBe(0);
        expect(mocks.fetch).not.toHaveBeenCalled();
        expect(findings).toContainEqual(
          expect.objectContaining({
            severity: "info",
            path: `mcp.servers.${SERVER_NAME}`,
            message: expect.stringContaining("OAuth"),
          }),
        );

        // Normal runtime probing still rotates exactly once and commits the replacement.
        const liveRuntime = await createBundleMcpToolRuntime({
          cfg,
          workspaceDir: state.workspaceDir,
        });
        try {
          expect(liveRuntime.diagnostics ?? []).toEqual([]);
          expect(liveRuntime.tools.some((tool) => tool.name.endsWith("__status"))).toBe(true);
          expect(network.refreshes).toBe(1);
          expect(network.replayDetected).toBe(false);
          expect(readMcpOAuthStoreReadOnly(IDENTITY.storeKey).tokens?.refresh_token).toBe(
            "fixture-refresh-1",
          );
        } finally {
          await liveRuntime.dispose();
        }
      });
    },
  );
});
