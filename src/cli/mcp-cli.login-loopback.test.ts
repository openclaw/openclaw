import { createServer } from "node:net";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startMcpOAuthAuthorization } from "../agents/mcp-oauth.js";
import { withTempHome } from "../config/home-env.test-harness.js";
import { getFreePort } from "../test-utils/ports.js";
import { registerMcpCli } from "./mcp-cli.js";
import {
  cleanupMcpCliTestState,
  completeMcpOAuthAuthorization,
  createWorkspace,
  mockLog,
  resetMcpCliTestState,
} from "./mcp-cli.test-harness.js";

const startAuthorization = vi.mocked(startMcpOAuthAuthorization);
let program: Command;

function waitForLog(text: string): Promise<void> {
  return new Promise((resolve) => {
    mockLog.mockImplementation((line) => {
      if (String(line).includes(text)) {
        resolve();
      }
    });
  });
}

async function withConfiguredServer(run: () => Promise<void>) {
  await withTempHome("openclaw-cli-mcp-loopback-home-", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace());
    await program.parseAsync(
      [
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ],
      { from: "user" },
    );
    mockLog.mockClear();
    await run();
  });
}

const login = () => program.parseAsync(["mcp", "login", "docs"], { from: "user" });
const logs = () => mockLog.mock.calls.map(([line]) => String(line)).join("\n");

function mockRedirectFlow(redirectUrl: string): void {
  const authorizationUrl = new URL("https://auth.example.com/authorize");
  authorizationUrl.searchParams.set("redirect_uri", redirectUrl);
  authorizationUrl.searchParams.set("state", "state-1234567890");
  startAuthorization.mockResolvedValue({
    status: "redirect",
    authorizationUrl: authorizationUrl.toString(),
    redirectUrl,
    state: "state-1234567890",
  });
  completeMcpOAuthAuthorization.mockResolvedValue("authorized");
}

describe("mcp login loopback callback", () => {
  beforeEach(() => {
    resetMcpCliTestState();
    mockLog.mockReset();
    program = new Command().exitOverride();
    registerMcpCli(program);
  });

  afterEach(cleanupMcpCliTestState);

  it("binds the final redirect before printing it and exchanges the captured code", async () => {
    await withConfiguredServer(async () => {
      const port = await getFreePort();
      const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
      mockRedirectFlow(redirectUrl);

      const waitingForBrowser = waitForLog("Waiting for the browser");
      const pendingLogin = login();
      await waitingForBrowser;
      expect(mockLog).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/auth\.example\.com\/authorize/),
      );

      const wrong = await fetch(`${redirectUrl}?code=wrong&state=wrong`);
      expect(wrong.status).toBe(400);
      expect(startAuthorization).toHaveBeenCalledOnce();
      expect(completeMcpOAuthAuthorization).not.toHaveBeenCalled();

      const response = await fetch(`${redirectUrl}?code=right&state=state-1234567890`);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Authorization received");
      await pendingLogin;

      expect(startAuthorization).toHaveBeenCalledOnce();
      expect(completeMcpOAuthAuthorization).toHaveBeenCalledOnce();
      expect(completeMcpOAuthAuthorization.mock.calls[0]?.[2]).toEqual({ code: "right" });
      expect(mockLog).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
    });
  });

  it("reports an existing session without starting the loopback", async () => {
    await withConfiguredServer(async () => {
      startAuthorization.mockResolvedValue({ status: "authorized" });

      await login();

      expect(mockLog).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
      expect(completeMcpOAuthAuthorization).not.toHaveBeenCalled();
      expect(logs()).not.toContain("Open this URL");
    });
  });

  it("falls back immediately to the printed manual command when binding fails", async () => {
    await withConfiguredServer(async () => {
      const blocker = createServer();
      await new Promise<void>((resolve) => {
        blocker.listen(0, "127.0.0.1", resolve);
      });
      const address = blocker.address();
      const port = typeof address === "object" && address ? address.port : 0;
      mockRedirectFlow(`http://127.0.0.1:${port}/oauth/callback`);

      await login();
      expect(logs()).toContain("Could not start");
      expect(logs()).toContain("--code");
      expect(startAuthorization).toHaveBeenCalledOnce();
      expect(completeMcpOAuthAuthorization).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    });
  });
});
