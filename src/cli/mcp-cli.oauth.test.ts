import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import {
  cleanupMcpCliTestState,
  clearMcpOAuthCredentials,
  countMcpOAuthPrincipals,
  completeMcpOAuthAuthorization,
  createWorkspace,
  lastErrorLine,
  lastLogLine,
  mockError,
  mockLog,
  readMcpOAuthCredentialsStatus,
  resetMcpCliTestState,
  runMcpCommand,
} from "./mcp-cli.test-harness.js";

const mcp = (...args: string[]) => runMcpCommand(["mcp", ...args]);
const httpServer = { url: "https://mcp.example.com", transport: "streamable-http" };
const setServer = (name: string, server: object) => mcp("set", name, JSON.stringify(server));
async function readServer() {
  mockLog.mockClear();
  await mcp("show", "docs", "--json");
  return JSON.parse(lastLogLine());
}

async function withMcpHome(run: () => Promise<void>) {
  await withTempHome("openclaw-cli-mcp-home-", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace());
    await run();
  });
}

describe("mcp cli OAuth", () => {
  beforeEach(() => {
    resetMcpCliTestState();
  });

  afterEach(async () => {
    await cleanupMcpCliTestState();
  });

  it("surfaces required OAuth authorization in status and doctor", async () => {
    await withMcpHome(async () => {
      readMcpOAuthCredentialsStatus.mockResolvedValue({
        state: "requires-authorization",
      });

      await setServer("docs", { ...httpServer, auth: "oauth" });
      mockLog.mockClear();

      await mcp("status", "--verbose");

      const statusLines = mockLog.mock.calls.map((call) => String(call[0]));
      expect(statusLines).toContain("- docs: streamable-http oauth authorization-required");
      expect(statusLines).toContain("  oauth: requires-authorization");

      mockLog.mockClear();
      await mcp("doctor", "--json");

      expect(JSON.parse(lastLogLine())).toMatchObject({
        ok: true,
        servers: [
          {
            name: "docs",
            ok: true,
            issues: [
              {
                level: "warning",
                message:
                  "OAuth credentials require additional authorization; run openclaw mcp login docs",
              },
            ],
          },
        ],
      });
    });
  });

  it("shows connected requester principals in list and status output", async () => {
    await withMcpHome(async () => {
      countMcpOAuthPrincipals.mockResolvedValue(2);

      await setServer("calendar", {
        ...httpServer,
        auth: "oauth",
        oauth: { identity: "per-requester" },
      });
      await setServer("context7", { command: "uvx", args: ["context7-mcp"] });
      mockLog.mockClear();

      await mcp("list");
      expect(mockLog.mock.calls.map(([line]) => String(line))).toContain(
        "- calendar (2 connected principals)",
      );
      const listing = mockLog.mock.calls.map(([line]) => String(line)).join("\n");
      expect(listing).toContain("- context7");
      expect(listing).toContain("OpenClaw-managed MCP servers (");
      expect(listing).toContain("OpenClaw-managed mcp.servers entries");
      expect(listing).toContain("does not include mcporter servers from config/mcporter.json");

      mockLog.mockClear();
      await mcp("status", "--json");
      expect(JSON.parse(lastLogLine()).servers[0]).toMatchObject({
        name: "calendar",
        connectedPrincipals: 2,
      });
      expect(readMcpOAuthCredentialsStatus).not.toHaveBeenCalled();
    });
  });

  it("configures enablement, timeouts, and OAuth login", async () => {
    await withMcpHome(async () => {
      completeMcpOAuthAuthorization.mockResolvedValueOnce("authorized");

      await setServer("docs", httpServer);
      await mcp("configure", "docs", "--disable", "--timeout", "9", "--auth", "oauth");
      await mcp("login", "docs", "--code", "abc123");

      expect(completeMcpOAuthAuthorization).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "docs",
          serverUrl: "https://mcp.example.com",
        }),
        expect.objectContaining({ url: "https://mcp.example.com" }),
        { code: "abc123" },
      );

      mockLog.mockClear();
      await mcp("status", "--json");
      expect(JSON.parse(lastLogLine()).servers[0]).toMatchObject({
        name: "docs",
        enabled: false,
        ok: false,
        requestTimeoutMs: 9_000,
        auth: "oauth",
      });
    });
  });

  it("preserves per-requester identity and redirect metadata when updating OAuth scope", async () => {
    await withMcpHome(async () => {
      const oauth = {
        identity: "per-requester",
        scope: "docs.read",
        redirectUrl: "https://gateway.example.com/oauth/mcp/callback",
        clientMetadataUrl: "https://gateway.example.com/oauth/mcp.json",
      };
      await setServer("docs", {
        ...httpServer,
        auth: "oauth",
        oauth,
        toolFilter: { include: ["old_*"], exclude: ["admin_*"] },
      });

      await mcp("configure", "docs", "--oauth-scope", "docs.write", "--include", "search");

      expect(await readServer()).toMatchObject({
        oauth: { ...oauth, scope: "docs.write" },
        toolFilter: { include: ["search"], exclude: ["admin_*"] },
      });
    });
  });

  it("does not restore previous OAuth metadata after an explicit clear", async () => {
    await withMcpHome(async () => {
      await setServer("docs", {
        url: "https://mcp.example.com",
        auth: "oauth",
        oauth: { authProfileId: "docs:mcp", scope: "docs.read" },
      });

      await mcp(
        "configure",
        "docs",
        "--clear-auth",
        "--auth",
        "oauth",
        "--oauth-scope",
        "docs.write",
      );

      expect((await readServer()).oauth).toEqual({ scope: "docs.write" });
    });
  });

  it("rejects operator login and logout for per-requester OAuth", async () => {
    await withMcpHome(async () => {
      await setServer("calendar", {
        ...httpServer,
        auth: "oauth",
        oauth: { identity: "per-requester" },
      });
      mockError.mockClear();
      completeMcpOAuthAuthorization.mockClear();
      clearMcpOAuthCredentials.mockClear();

      await expect(mcp("login", "calendar", "--code", "abc123")).rejects.toMatchObject({ code: 1 });
      expect(lastErrorLine()).toBe(
        'MCP server "calendar" uses per-requester OAuth. Senders connect from the channel via the MCP connect flow.',
      );
      expect(completeMcpOAuthAuthorization).not.toHaveBeenCalled();

      mockError.mockClear();
      await expect(mcp("logout", "calendar")).rejects.toMatchObject({ code: 1 });
      expect(lastErrorLine()).toBe(
        'MCP server "calendar" uses per-requester OAuth. Remove or replace the server to clear requester credentials.',
      );
      expect(clearMcpOAuthCredentials).not.toHaveBeenCalled();
    });
  });

  it("clears stored OAuth credentials after auth is removed", async () => {
    await withMcpHome(async () => {
      await setServer("docs", httpServer);
      clearMcpOAuthCredentials.mockClear();
      await mcp("logout", "docs");

      expect(clearMcpOAuthCredentials).toHaveBeenCalledWith(
        expect.objectContaining({
          serverName: "docs",
          serverUrl: "https://mcp.example.com",
        }),
      );
    });
  });
});
