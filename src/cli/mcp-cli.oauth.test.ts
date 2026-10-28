import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTempHomeEnv } from "../test-utils/temp-home.js";
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

let restoreHome: () => Promise<void>;

beforeEach(async () => {
  resetMcpCliTestState();
  const env = await createTempHomeEnv("openclaw-cli-mcp-home-");
  restoreHome = env.restore;
  vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace());
});

afterEach(async () => {
  try {
    await restoreHome();
  } finally {
    await cleanupMcpCliTestState();
  }
});

it("shows connected requester principals in list and status output", async () => {
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

it("configures enablement, timeouts, and OAuth login", async () => {
  completeMcpOAuthAuthorization.mockResolvedValueOnce("authorized");

  await setServer("docs", httpServer);
  await mcp("configure", "docs", "--disable", "--timeout", "9", "--auth", "oauth");
  await mcp("login", "docs", "--code", "abc123", "--issuer", "https://issuer.example/tenant/");

  expect(completeMcpOAuthAuthorization).toHaveBeenCalledWith(
    expect.objectContaining({
      serverName: "docs",
      serverUrl: "https://mcp.example.com",
    }),
    expect.objectContaining({ url: "https://mcp.example.com" }),
    { code: "abc123", iss: "https://issuer.example/tenant/" },
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

it("preserves per-requester identity and redirect metadata when updating OAuth scope", async () => {
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

it("does not restore previous OAuth metadata after an explicit clear", async () => {
  await setServer("docs", {
    url: "https://mcp.example.com",
    auth: "oauth",
    oauth: { authProfileId: "docs:mcp", scope: "docs.read" },
  });

  await mcp("configure", "docs", "--clear-auth", "--auth", "oauth", "--oauth-scope", "docs.write");

  expect((await readServer()).oauth).toEqual({ scope: "docs.write" });
});

it.each(["login", "logout"] as const)(
  "rejects operator %s for per-requester OAuth",
  async (command) => {
    await setServer("calendar", {
      ...httpServer,
      auth: "oauth",
      oauth: { identity: "per-requester" },
    });
    const operation =
      command === "login" ? completeMcpOAuthAuthorization : clearMcpOAuthCredentials;
    operation.mockClear();
    mockError.mockClear();
    await expect(
      mcp(command, "calendar", ...(command === "login" ? ["--code", "abc123"] : [])),
    ).rejects.toMatchObject({ code: 1 });
    expect(lastErrorLine()).toBe(
      `MCP server "calendar" uses per-requester OAuth. ${
        command === "login"
          ? "Senders connect from the channel via the MCP connect flow."
          : "Remove or replace the server to clear requester credentials."
      }`,
    );
    expect(operation).not.toHaveBeenCalled();
  },
);

it("clears stored OAuth credentials after auth is removed", async () => {
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
