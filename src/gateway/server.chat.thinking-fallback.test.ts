import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { clearConfigCache } from "../config/config.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  installGatewayTestHooks,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });
type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let harness: GatewayHarness;

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
});

async function writeGatewayConfig(config: Record<string, unknown>): Promise<void> {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  clearConfigCache();
}

async function withHarness(
  run: (ctx: { ws: GatewaySocket; createSessionDir: () => Promise<string> }) => Promise<void>,
): Promise<void> {
  const tempDirs: string[] = [];
  const ws = await harness.openWs();
  const createSessionDir = async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gw-think-"));
    tempDirs.push(sessionDir);
    testState.sessionStorePath = path.join(sessionDir, "sessions.json");
    return sessionDir;
  };

  try {
    await run({ ws, createSessionDir });
  } finally {
    clearConfigCache();
    testState.sessionStorePath = undefined;
    ws.close();
    await Promise.all(tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true })));
  }
}

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

function buildAgentCfg(opts: { thinkingDefault?: ThinkLevel }): Record<string, unknown> {
  return {
    agents: {
      list: [
        {
          id: "main",
          model: "openai-codex/gpt-5.4",
          ...(opts.thinkingDefault ? { thinkingDefault: opts.thinkingDefault } : {}),
        },
      ],
    },
  };
}

async function seedMainSession(
  sessionDir: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const transcriptPath = path.join(sessionDir, "sess-main.jsonl");
  await fs.writeFile(
    transcriptPath,
    `${JSON.stringify({ type: "session", id: "sess-main" })}\n`,
    "utf-8",
  );
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        sessionFile: transcriptPath,
        updatedAt: Date.now(),
        ...overrides,
      },
    },
  });
}

async function fetchThinkingLevel(
  ws: GatewaySocket,
  sessionKey: string = "main",
): Promise<unknown> {
  const res = await rpcReq<{ thinkingLevel?: unknown }>(ws, "chat.history", {
    sessionKey,
    limit: 10,
  });
  expect(res.ok).toBe(true);
  return res.payload?.thinkingLevel;
}

describe("chat.history thinkingLevel fallback (agent-aware)", () => {
  test("returns per-agent thinkingDefault when the session entry has no thinkingLevel", async () => {
    await withHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig(buildAgentCfg({ thinkingDefault: "high" }));
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await seedMainSession(sessionDir);
      const thinkingLevel = await fetchThinkingLevel(ws);
      expect(thinkingLevel).toBe("high");
    });
  });

  test("session-specific entry.thinkingLevel wins over per-agent thinkingDefault (regression guard)", async () => {
    await withHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig(buildAgentCfg({ thinkingDefault: "high" }));
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await seedMainSession(sessionDir, { thinkingLevel: "medium" });
      const thinkingLevel = await fetchThinkingLevel(ws);
      expect(thinkingLevel).toBe("medium");
    });
  });

  test("agent without thinkingDefault still falls through to the shared resolver", async () => {
    await withHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig(buildAgentCfg({}));
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await seedMainSession(sessionDir);
      const thinkingLevel = await fetchThinkingLevel(ws);
      // Whatever resolveThinkingDefault returns for this provider/model combo,
      // it must be a concrete ThinkLevel string, not undefined — proving the
      // agent-aware branch did not short-circuit with a missing value.
      expect(typeof thinkingLevel).toBe("string");
      expect((thinkingLevel as string).length).toBeGreaterThan(0);
    });
  });

  test("canonical webchat sessionKey 'agent:main:main' resolves the per-agent thinkingDefault", async () => {
    await withHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig(buildAgentCfg({ thinkingDefault: "high" }));
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      await seedMainSession(sessionDir);
      const thinkingLevel = await fetchThinkingLevel(ws, "agent:main:main");
      expect(thinkingLevel).toBe("high");
    });
  });
});
