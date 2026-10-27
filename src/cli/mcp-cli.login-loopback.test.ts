import { createServer } from "node:net";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../config/home-env.test-harness.js";
import { getFreePort } from "../test-utils/ports.js";
import {
  cleanupMcpCliTestState,
  createMcpProgram,
  createWorkspace,
  mcpCliMocks as mocks,
  resetMcpCliTestState,
} from "./mcp-cli.test-harness.js";

let program: Command;

function waitForLog(text: string): Promise<void> {
  return new Promise((resolve) => {
    mocks.runtime.log.mockImplementation((line) => {
      if (String(line).includes(text)) {
        resolve();
      }
    });
  });
}

async function withServer(run: () => Promise<void>) {
  await withTempHome("openclaw-cli-mcp-loopback-home-", async () => {
    vi.spyOn(process, "cwd").mockReturnValue(await createWorkspace("openclaw-cli-mcp-loopback-"));
    await program.parseAsync(
      [
        "mcp",
        "set",
        "docs",
        '{"url":"https://mcp.example.com","transport":"streamable-http","auth":"oauth"}',
      ],
      { from: "user" },
    );
    mocks.runtime.log.mockClear();
    await run();
  });
}

const login = () => program.parseAsync(["mcp", "login", "docs"], { from: "user" });
const expectLogged = (text: string) =>
  expect(mocks.runtime.log).toHaveBeenCalledWith(expect.stringContaining(text));

function mockRedirectFlow(redirectUrl: string): void {
  const authorizationUrl = new URL("https://auth.example.com/authorize");
  authorizationUrl.searchParams.set("redirect_uri", redirectUrl);
  authorizationUrl.searchParams.set("state", "state-1234567890");
  mocks.startMcpOAuthAuthorization.mockResolvedValue({
    status: "redirect",
    authorizationUrl: authorizationUrl.toString(),
    redirectUrl,
    state: "state-1234567890",
  });
  mocks.completeMcpOAuthAuthorization.mockResolvedValue("authorized");
}

describe("mcp login loopback callback", () => {
  beforeEach(() => {
    resetMcpCliTestState();
    vi.spyOn(mocks.runtime, "log").mockReset();
    vi.spyOn(mocks.runtime, "writeJson").mockImplementation(() => {});
    program = createMcpProgram();
  });

  afterEach(cleanupMcpCliTestState);

  it("binds the final redirect before printing it and exchanges the captured code", async () => {
    await withServer(async () => {
      const port = await getFreePort();
      const redirectUrl = `http://127.0.0.1:${port}/oauth/callback`;
      mockRedirectFlow(redirectUrl);

      const waitingForBrowser = waitForLog("Waiting for the browser");
      const loggingIn = login();
      await waitingForBrowser;
      expect(mocks.runtime.log).toHaveBeenCalledWith(
        expect.stringMatching(/^https:\/\/auth\.example\.com\/authorize/),
      );

      const wrong = await fetch(`${redirectUrl}?code=wrong&state=wrong`);
      expect(wrong.status).toBe(400);
      expect(mocks.completeMcpOAuthAuthorization).not.toHaveBeenCalled();

      const response = await fetch(
        `${redirectUrl}?code=right&state=state-1234567890&iss=https%3A%2F%2Fauth.example.com%2Ftenant%2F`,
      );
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toContain("Authorization received");
      await loggingIn;

      expect(mocks.completeMcpOAuthAuthorization).toHaveBeenCalledOnce();
      expect(mocks.completeMcpOAuthAuthorization.mock.calls[0]?.[2]).toEqual({
        code: "right",
        iss: "https://auth.example.com/tenant/",
      });
      expect(mocks.runtime.log).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
    });
  });

  it("reports an existing session without starting the loopback", async () => {
    await withServer(async () => {
      mocks.startMcpOAuthAuthorization.mockResolvedValue({ status: "authorized" });
      await login();
      expect(mocks.runtime.log).toHaveBeenCalledWith('MCP OAuth credentials saved for "docs".');
      expect(mocks.completeMcpOAuthAuthorization).not.toHaveBeenCalled();
      expect(mocks.runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Open this URL"));
    });
  });

  it("falls back immediately to the printed manual command when binding fails", async () => {
    await withServer(async () => {
      const blocker = createServer();
      await new Promise<void>((resolve) => {
        blocker.listen(0, "127.0.0.1", resolve);
      });
      const address = blocker.address();
      const port = typeof address === "object" && address ? address.port : 0;
      mockRedirectFlow(`http://127.0.0.1:${port}/oauth/callback`);

      await login();
      expectLogged("Could not start");
      expectLogged("--code");
      expect(mocks.completeMcpOAuthAuthorization).not.toHaveBeenCalled();
      await new Promise<void>((resolve) => {
        blocker.close(() => resolve());
      });
    });
  });
});
