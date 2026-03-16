import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  connectOk,
  installGatewayTestHooks,
  rpcReq,
  startServerWithClient,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

let startedServer: Awaited<ReturnType<typeof startServerWithClient>> | null = null;
let sharedTempRoot: string;

function requireWs(): Awaited<ReturnType<typeof startServerWithClient>>["ws"] {
  if (!startedServer) {
    throw new Error("gateway test server not started");
  }
  return startedServer.ws;
}

beforeAll(async () => {
  sharedTempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-config-"));
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
  await fs.rm(sharedTempRoot, { recursive: true, force: true });
});

async function resetTempDir(name: string): Promise<string> {
  const dir = path.join(sharedTempRoot, name);
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function getConfigHash() {
  const current = await rpcReq<{
    hash?: string;
  }>(requireWs(), "config.get", {});
  expect(current.ok).toBe(true);
  expect(typeof current.payload?.hash).toBe("string");
  return String(current.payload?.hash);
}

async function expectSchemaLookupInvalid(path: unknown) {
  const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.schema.lookup", { path });
  expect(res.ok).toBe(false);
  expect(res.error?.message ?? "").toContain("invalid config.schema.lookup params");
}

type LiveConfig = Record<string, unknown> & {
  commands?: { restart?: boolean };
  logging?: { level?: string };
};

async function getLiveConfig(): Promise<{ hash: string; config: LiveConfig }> {
  const res = await rpcReq<{
    raw?: unknown;
    hash?: string;
    config?: LiveConfig;
  }>(requireWs(), "config.get", {});
  expect(res.ok).toBe(true);
  expect(typeof res.payload?.hash).toBe("string");
  expect(res.payload?.config).toBeTruthy();
  return {
    hash: res.payload?.hash as string,
    config: res.payload?.config as LiveConfig,
  };
}

async function writeLiveConfig(config: LiveConfig, baseHash: string): Promise<void> {
  const res = await rpcReq<{
    ok?: boolean;
    path?: string;
    config?: LiveConfig;
  }>(requireWs(), "config.set", {
    raw: JSON.stringify(config, null, 2),
    baseHash,
  });
  expect(res.ok).toBe(true);
  expect(res.payload?.config).toBeTruthy();
}

function pickAlternateLogLevel(config: LiveConfig): string {
  return config.logging?.level === "debug" ? "info" : "debug";
}

describe("gateway config methods", () => {
  it("round-trips config.set and returns the live config path", async () => {
    const { createConfigIO } = await import("../config/config.js");
    const current = await rpcReq<{
      raw?: unknown;
      hash?: string;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.get", {});
    expect(current.ok).toBe(true);
    expect(typeof current.payload?.hash).toBe("string");
    expect(current.payload?.config).toBeTruthy();

    const res = await rpcReq<{
      ok?: boolean;
      path?: string;
      config?: Record<string, unknown>;
    }>(requireWs(), "config.set", {
      raw: JSON.stringify(current.payload?.config ?? {}, null, 2),
      baseHash: current.payload?.hash,
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.path).toBe(createConfigIO().configPath);
    expect(res.payload?.config).toBeTruthy();
  });

  it("returns config.set validation details in the top-level error message", async () => {
    const res = await rpcReq<{
      ok?: boolean;
      error?: {
        message?: string;
      };
    }>(requireWs(), "config.set", {
      raw: JSON.stringify({ gateway: { bind: 123 } }),
      baseHash: await getConfigHash(),
    });
    const error = res.error as
      | {
          message?: string;
          details?: {
            issues?: Array<{ path?: string; message?: string }>;
          };
        }
      | undefined;

    expect(res.ok).toBe(false);
    expect(error?.message ?? "").toContain("invalid config:");
    expect(error?.message ?? "").toContain("gateway.bind");
    expect(error?.message ?? "").toContain("allowed:");
    expect(error?.details?.issues?.[0]?.path).toBe("gateway.bind");
  });

  it("returns a path-scoped config schema lookup", async () => {
    const res = await rpcReq<{
      path: string;
      hintPath?: string;
      children?: Array<{ key: string; path: string; required: boolean; hintPath?: string }>;
      schema?: { properties?: unknown };
    }>(requireWs(), "config.schema.lookup", {
      path: "gateway.auth",
    });

    expect(res.ok).toBe(true);
    expect(res.payload?.path).toBe("gateway.auth");
    expect(res.payload?.hintPath).toBe("gateway.auth");
    const tokenChild = res.payload?.children?.find((child) => child.key === "token");
    expect(tokenChild).toMatchObject({
      key: "token",
      path: "gateway.auth.token",
      hintPath: "gateway.auth.token",
    });
    expect(res.payload?.schema?.properties).toBeUndefined();
  });

  it("rejects config.schema.lookup when the path is missing", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.schema.lookup", {
      path: "gateway.notReal.path",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("config schema path not found");
  });

  it.each([
    { name: "rejects config.schema.lookup when the path is only whitespace", path: "   " },
    {
      name: "rejects config.schema.lookup when the path exceeds the protocol limit",
      path: `gateway.${"a".repeat(1020)}`,
    },
    {
      name: "rejects config.schema.lookup when the path contains invalid characters",
      path: "gateway.auth\nspoof",
    },
    {
      name: "rejects config.schema.lookup when the path is not a string",
      path: 42,
    },
  ])("$name", async ({ path }) => {
    await expectSchemaLookupInvalid(path);
  });

  it("rejects prototype-chain config.schema.lookup paths without reflecting them", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.schema.lookup", {
      path: "constructor",
    });

    expect(res.ok).toBe(false);
    expect(res.error?.message).toBe("config schema path not found");
  });

  it("rejects config.patch when raw is not an object", async () => {
    const res = await rpcReq<{ ok?: boolean }>(requireWs(), "config.patch", {
      raw: "[]",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("raw must be an object");
  });

  it("skips automatic restart for config.patch when commands.restart is disabled", async () => {
    const original = await getLiveConfig();
    try {
      const nextLogLevel = pickAlternateLogLevel(original.config);
      const restartDisabled = structuredClone(original.config);
      restartDisabled.commands = { ...(restartDisabled.commands ?? {}), restart: false };
      await writeLiveConfig(restartDisabled, original.hash);

      const current = await getLiveConfig();
      const res = await rpcReq<{
        ok?: boolean;
        config?: LiveConfig;
        restart?: unknown;
        sentinel?: unknown;
      }>(requireWs(), "config.patch", {
        raw: JSON.stringify({ logging: { level: nextLogLevel } }, null, 2),
        baseHash: current.hash,
      });

      expect(res.ok).toBe(true);
      expect(res.payload?.restart).toBeNull();
      expect(res.payload?.sentinel).toBeNull();
      expect(res.payload?.config?.commands?.restart).toBe(false);
      expect(res.payload?.config?.logging?.level).toBe(nextLogLevel);
    } finally {
      const latest = await getLiveConfig();
      await writeLiveConfig(original.config, latest.hash);
    }
  });

  it("skips automatic restart for config.apply when commands.restart is disabled", async () => {
    const original = await getLiveConfig();
    try {
      const nextLogLevel = pickAlternateLogLevel(original.config);
      const updated = structuredClone(original.config);
      updated.commands = { ...(updated.commands ?? {}), restart: false };
      updated.logging = { ...(updated.logging ?? {}), level: nextLogLevel };

      const res = await rpcReq<{
        ok?: boolean;
        config?: LiveConfig;
        restart?: unknown;
        sentinel?: unknown;
      }>(requireWs(), "config.apply", {
        raw: JSON.stringify(updated, null, 2),
        baseHash: original.hash,
      });

      expect(res.ok).toBe(true);
      expect(res.payload?.restart).toBeNull();
      expect(res.payload?.sentinel).toBeNull();
      expect(res.payload?.config?.commands?.restart).toBe(false);
      expect(res.payload?.config?.logging?.level).toBe(nextLogLevel);
    } finally {
      const latest = await getLiveConfig();
      await writeLiveConfig(original.config, latest.hash);
    }
  });
});

describe("gateway server sessions", () => {
  it("filters sessions by agentId", async () => {
    const dir = await resetTempDir("agents");
    testState.sessionConfig = {
      store: path.join(dir, "{agentId}", "sessions.json"),
    };
    testState.agentsConfig = {
      list: [{ id: "home", default: true }, { id: "work" }],
    };
    const homeDir = path.join(dir, "home");
    const workDir = path.join(dir, "work");
    await fs.mkdir(homeDir, { recursive: true });
    await fs.mkdir(workDir, { recursive: true });
    await writeSessionStore({
      storePath: path.join(homeDir, "sessions.json"),
      agentId: "home",
      entries: {
        main: {
          sessionId: "sess-home-main",
          updatedAt: Date.now(),
        },
        "discord:group:dev": {
          sessionId: "sess-home-group",
          updatedAt: Date.now() - 1000,
        },
      },
    });
    await writeSessionStore({
      storePath: path.join(workDir, "sessions.json"),
      agentId: "work",
      entries: {
        main: {
          sessionId: "sess-work-main",
          updatedAt: Date.now(),
        },
      },
    });

    const homeSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(requireWs(), "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "home",
    });
    expect(homeSessions.ok).toBe(true);
    expect(homeSessions.payload?.sessions.map((s) => s.key).toSorted()).toEqual([
      "agent:home:discord:group:dev",
      "agent:home:main",
    ]);

    const workSessions = await rpcReq<{
      sessions: Array<{ key: string }>;
    }>(requireWs(), "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "work",
    });
    expect(workSessions.ok).toBe(true);
    expect(workSessions.payload?.sessions.map((s) => s.key)).toEqual(["agent:work:main"]);
  });

  it("resolves and patches main alias to default agent main key", async () => {
    const dir = await resetTempDir("main-alias");
    const storePath = path.join(dir, "sessions.json");
    testState.sessionStorePath = storePath;
    testState.agentsConfig = { list: [{ id: "ops", default: true }] };
    testState.sessionConfig = { mainKey: "work" };

    await writeSessionStore({
      storePath,
      agentId: "ops",
      mainKey: "work",
      entries: {
        main: {
          sessionId: "sess-ops-main",
          updatedAt: Date.now(),
        },
      },
    });

    const resolved = await rpcReq<{ ok: true; key: string }>(requireWs(), "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string }>(requireWs(), "sessions.patch", {
      key: "main",
      thinkingLevel: "medium",
    });
    expect(patched.ok).toBe(true);
    expect(patched.payload?.key).toBe("agent:ops:work");

    const stored = JSON.parse(await fs.readFile(storePath, "utf-8")) as Record<
      string,
      { thinkingLevel?: string }
    >;
    expect(stored["agent:ops:work"]?.thinkingLevel).toBe("medium");
    expect(stored.main).toBeUndefined();
  });
});
