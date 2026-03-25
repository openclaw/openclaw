import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readMctlCredentials,
  resolveMctlCredentialsPath,
  writeMctlCredentials,
  type MctlConnectStatus,
} from "../mctl/oauth-store.js";
import { mctlHandlers } from "./server-methods/mctl.js";

function makeJwt(sub: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `${header}.${payload}.sig`;
}

async function invokeStatus(): Promise<MctlConnectStatus> {
  return await new Promise<MctlConnectStatus>((resolve, reject) => {
    void mctlHandlers["mctl.connect.status"]({
      params: {},
      client: null,
      isWebchatConnect: () => false,
      req: { id: "req-1", method: "mctl.connect.status" },
      context: {} as never,
      respond: (ok, payload, error) => {
        if (!ok) {
          reject(new Error(error?.message ?? "request failed"));
          return;
        }
        resolve(payload as MctlConnectStatus);
      },
    });
  });
}

describe("mctl.connect.status", () => {
  let stateDir: string;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  const originalApiUrl = process.env.MCTL_API_URL;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mctl-refresh-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.MCTL_API_URL = "https://api.test.mctl.ai";
    vi.restoreAllMocks();
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    if (originalStateDir == null) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
    if (originalApiUrl == null) {
      delete process.env.MCTL_API_URL;
    } else {
      process.env.MCTL_API_URL = originalApiUrl;
    }
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("silently refreshes expired credentials and returns connected", async () => {
    await writeMctlCredentials({
      version: 1,
      apiBase: "https://api.test.mctl.ai",
      clientId: "client-1",
      accessToken: makeJwt("old-user"),
      refreshToken: "refresh-1",
      scope: "mctl",
      login: "old-user",
      connectedAt: "2026-03-25T10:00:00.000Z",
      updatedAt: "2026-03-25T10:00:00.000Z",
      expiresAt: "2026-03-25T10:05:00.000Z",
    });
    vi.setSystemTime(new Date("2026-03-25T10:06:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = init?.body;
        expect(body).toBeInstanceOf(URLSearchParams);
        expect((body as URLSearchParams).get("grant_type")).toBe("refresh_token");
        expect((body as URLSearchParams).get("refresh_token")).toBe("refresh-1");
        return new Response(
          JSON.stringify({
            access_token: makeJwt("mashkoffdmitry"),
            expires_in: 3600,
            scope: "mctl",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const status = await invokeStatus();
    const stored = await readMctlCredentials();

    expect(status.state).toBe("connected");
    expect(status.connected).toBe(true);
    expect(status.login).toBe("mashkoffdmitry");
    expect(stored?.login).toBe("mashkoffdmitry");
    expect(stored?.refreshToken).toBe("refresh-1");
    expect(stored?.updatedAt).toBe("2026-03-25T10:06:00.000Z");
    expect(stored?.expiresAt).toBe("2026-03-25T11:06:00.000Z");
  });

  it("clears unusable credentials when refresh token is invalid", async () => {
    await writeMctlCredentials({
      version: 1,
      apiBase: "https://api.test.mctl.ai",
      clientId: "client-1",
      accessToken: makeJwt("old-user"),
      refreshToken: "refresh-dead",
      scope: "mctl",
      login: "old-user",
      connectedAt: "2026-03-25T10:00:00.000Z",
      updatedAt: "2026-03-25T10:00:00.000Z",
      expiresAt: "2026-03-25T10:05:00.000Z",
    });
    vi.setSystemTime(new Date("2026-03-25T10:06:00.000Z"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            error: "invalid_grant",
            error_description: "refresh token expired",
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }),
    );

    const status = await invokeStatus();

    expect(status.state).toBe("disconnected");
    await expect(fs.access(resolveMctlCredentialsPath())).rejects.toThrow();
  });
});
