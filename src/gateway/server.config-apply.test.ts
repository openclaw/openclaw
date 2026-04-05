import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveOpenClawAgentDir } from "../agents/agent-paths.js";
import { AUTH_PROFILE_FILENAME } from "../agents/auth-profiles/constants.js";
import { __testing as controlPlaneRateLimitTesting } from "./control-plane-rate-limit.js";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startedServer: Awaited<ReturnType<typeof startServerWithClient>> | null = null;

beforeAll(async () => {
  startedServer = await startServerWithClient(undefined, { controlUiEnabled: true });
  await connectOk(requireWs());
});

afterAll(async () => {
  if (!startedServer) {
    return;
  }
  startedServer.ws.close();
  await startedServer.server.close();
  startedServer = null;
});

function requireWs() {
  if (!startedServer) {
    throw new Error("gateway test server not started");
  }
  return startedServer.ws;
}

const sendConfigApply = async (params: { raw: unknown; baseHash?: string }, timeoutMs?: number) => {
  return await rpcReq(requireWs(), "config.apply", params, timeoutMs);
};

const sendConfigGet = async () => {
  return await rpcReq<{
    hash?: string;
    raw?: string | null;
    config?: Record<string, unknown>;
  }>(requireWs(), "config.get", {});
};

describe("gateway config.apply", () => {
  beforeEach(() => {
    controlPlaneRateLimitTesting.resetControlPlaneRateLimitState();
  });

  it("rejects config.apply when SecretRef resolution fails", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_SECRETREF_APPLY_${Date.now()}`;
    delete process.env[missingEnvVar];
    const current = await sendConfigGet();
    expect(current.ok).toBe(true);
    expect(typeof current.payload?.hash).toBe("string");
    const nextConfig = structuredClone(current.payload?.config ?? {});
    const channels = (nextConfig.channels ??= {}) as Record<string, unknown>;
    const telegram = (channels.telegram ??= {}) as Record<string, unknown>;
    telegram.botToken = { source: "env", provider: "default", id: missingEnvVar };
    const telegramAccounts = (telegram.accounts ??= {}) as Record<string, unknown>;
    const defaultTelegramAccount = (telegramAccounts.default ??= {}) as Record<string, unknown>;
    defaultTelegramAccount.enabled = true;

    const res = await sendConfigApply(
      {
        raw: JSON.stringify(nextConfig, null, 2),
        baseHash: current.payload?.hash,
      },
      20_000,
    );
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("active SecretRef resolution failed");

    const after = await sendConfigGet();
    expect(after.ok).toBe(true);
    expect(after.payload?.hash).toBe(current.payload?.hash);
    expect(after.payload?.raw).toBe(current.payload?.raw);
  });

  it("does not reject config.apply for unresolved auth-profile refs outside submitted config", async () => {
    const missingEnvVar = `OPENCLAW_MISSING_AUTH_PROFILE_REF_APPLY_${Date.now()}`;
    delete process.env[missingEnvVar];

    const authStorePath = path.join(resolveOpenClawAgentDir(), AUTH_PROFILE_FILENAME);
    await fs.mkdir(path.dirname(authStorePath), { recursive: true });
    await fs.writeFile(
      authStorePath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "custom:token": {
              type: "token",
              provider: "custom",
              tokenRef: { source: "env", provider: "default", id: missingEnvVar },
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    const current = await sendConfigGet();
    expect(current.ok).toBe(true);
    expect(current.payload?.config).toBeTruthy();

    const res = await sendConfigApply({
      raw: JSON.stringify(current.payload?.config ?? {}, null, 2),
      baseHash: current.payload?.hash,
    });
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });

  it("rejects invalid raw config", async () => {
    const current = await sendConfigGet();
    expect(current.ok).toBe(true);
    const res = await sendConfigApply({ raw: "{", baseHash: current.payload?.hash });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toMatch(/invalid|SyntaxError/i);
  });

  it("requires raw to be a string", async () => {
    const current = await sendConfigGet();
    expect(current.ok).toBe(true);
    const res = await sendConfigApply({
      raw: { gateway: { mode: "local" } },
      baseHash: current.payload?.hash,
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("raw");
  });
});
