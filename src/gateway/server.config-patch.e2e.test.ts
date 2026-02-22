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

let server: Awaited<ReturnType<typeof startServerWithClient>>["server"];
let ws: Awaited<ReturnType<typeof startServerWithClient>>["ws"];

beforeAll(async () => {
  const started = await startServerWithClient(undefined, { controlUiEnabled: true });
  server = started.server;
  ws = started.ws;
  await connectOk(ws);
});

afterAll(async () => {
  ws.close();
  await server.close();
});

describe("gateway config methods", () => {
  type AgentConfigEntry = {
    id: string;
    default?: boolean;
    workspace?: string;
  };

  const seedAgentsConfig = async (list: AgentConfigEntry[]) => {
    const setRes = await rpcReq<{ ok?: boolean }>(ws, "config.set", {
      raw: JSON.stringify({
        agents: {
          list,
        },
      }),
    });
    expect(setRes.ok).toBe(true);
  };

  const readConfigHash = async () => {
    const snapshotRes = await rpcReq<{ hash?: string }>(ws, "config.get", {});
    expect(snapshotRes.ok).toBe(true);
    expect(typeof snapshotRes.payload?.hash).toBe("string");
    return snapshotRes.payload?.hash ?? "";
  };

  it("returns a config snapshot", async () => {
    const res = await rpcReq<{ hash?: string; raw?: string }>(ws, "config.get", {});
    expect(res.ok).toBe(true);
    const payload = res.payload ?? {};
    expect(typeof payload.raw === "string" || typeof payload.hash === "string").toBe(true);
  });

  it("rejects config.patch when raw is not an object", async () => {
    const res = await rpcReq<{ ok?: boolean }>(ws, "config.patch", {
      raw: "[]",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.message ?? "").toContain("raw must be an object");
  });

  it("merges agents.list entries by id instead of replacing the full array", async () => {
    await seedAgentsConfig([
      { id: "primary", default: true, workspace: "/tmp/primary" },
      { id: "secondary", workspace: "/tmp/secondary" },
    ]);
    const baseHash = await readConfigHash();

    const patchRes = await rpcReq<{
      config?: {
        agents?: {
          list?: Array<{
            id?: string;
            workspace?: string;
          }>;
        };
      };
    }>(ws, "config.patch", {
      baseHash,
      raw: JSON.stringify({
        agents: {
          list: [
            {
              id: "primary",
              workspace: "/tmp/primary-updated",
            },
          ],
        },
      }),
    });
    expect(patchRes.ok).toBe(true);

    const list = patchRes.payload?.config?.agents?.list ?? [];
    expect(list).toHaveLength(2);
    const primary = list.find((entry) => entry.id === "primary");
    const secondary = list.find((entry) => entry.id === "secondary");
    expect(primary?.workspace).toBe("/tmp/primary-updated");
    expect(secondary?.workspace).toBe("/tmp/secondary");
  });

  it("rejects mixed-id agents.list patches without mutating persisted config", async () => {
    await seedAgentsConfig([
      { id: "primary", default: true, workspace: "/tmp/primary" },
      { id: "secondary", workspace: "/tmp/secondary" },
    ]);
    const beforeHash = await readConfigHash();

    const patchRes = await rpcReq<{ ok?: boolean }>(ws, "config.patch", {
      baseHash: beforeHash,
      raw: JSON.stringify({
        agents: {
          list: [
            {
              id: "primary",
              workspace: "/tmp/primary-updated",
            },
            {
              workspace: "/tmp/orphan-no-id",
            },
          ],
        },
      }),
    });
    expect(patchRes.ok).toBe(false);
    expect(patchRes.error?.message ?? "").toContain("invalid config");

    const afterHash = await readConfigHash();
    expect(afterHash).toBe(beforeHash);
  });
});

describe("gateway server sessions", () => {
  it("filters sessions by agentId", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-agents-"));
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
    }>(ws, "sessions.list", {
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
    }>(ws, "sessions.list", {
      includeGlobal: false,
      includeUnknown: false,
      agentId: "work",
    });
    expect(workSessions.ok).toBe(true);
    expect(workSessions.payload?.sessions.map((s) => s.key)).toEqual(["agent:work:main"]);
  });

  it("resolves and patches main alias to default agent main key", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-sessions-"));
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

    const resolved = await rpcReq<{ ok: true; key: string }>(ws, "sessions.resolve", {
      key: "main",
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.payload?.key).toBe("agent:ops:work");

    const patched = await rpcReq<{ ok: true; key: string }>(ws, "sessions.patch", {
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
