import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resetConfigRuntimeState, setRuntimeConfigSnapshot } from "../config/config.js";
import type { SessionEntry } from "../config/sessions.js";
import { withStateDirEnv } from "../test-helpers/state-dir-env.js";
import { listSessionsFromStore, loadGatewaySessionRow } from "./session-utils.js";

type ThinkLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive";

afterEach(() => {
  resetConfigRuntimeState();
});

function makeCfg(opts: {
  agentEntry?: {
    id?: string;
    thinkingDefault?: ThinkLevel;
    model?: string;
  };
  defaultsThinkingDefault?: ThinkLevel;
}): OpenClawConfig {
  const agentId = opts.agentEntry?.id ?? "main";
  return {
    session: { mainKey: "main" },
    agents: {
      defaults: {
        model: { primary: "openai-codex/gpt-5.4" },
        ...(opts.defaultsThinkingDefault ? { thinkingDefault: opts.defaultsThinkingDefault } : {}),
      },
      list: [
        {
          id: agentId,
          default: true,
          ...(opts.agentEntry?.thinkingDefault
            ? { thinkingDefault: opts.agentEntry.thinkingDefault }
            : {}),
          ...(opts.agentEntry?.model ? { model: opts.agentEntry.model } : {}),
        },
      ],
    },
  } as OpenClawConfig;
}

function listSingleMainSession(
  cfg: OpenClawConfig,
  entry: Partial<SessionEntry>,
): ReturnType<typeof listSessionsFromStore>["sessions"] {
  const storePath = "/tmp/sessions-utils-thinking-fallback.json";
  const fullEntry = {
    sessionId: "sess-test",
    updatedAt: Date.now(),
    ...entry,
  } as SessionEntry;
  const result = listSessionsFromStore({
    cfg,
    storePath,
    store: { "agent:main:main": fullEntry },
    opts: {},
  });
  return result.sessions;
}

describe("buildGatewaySessionRow → thinkingLevel fallback", () => {
  test("entry.thinkingLevel wins over per-agent default (regression guard)", () => {
    const cfg = makeCfg({ agentEntry: { thinkingDefault: "high" } });
    const [row] = listSingleMainSession(cfg, { thinkingLevel: "medium" });
    expect(row?.thinkingLevel).toBe("medium");
  });

  test("per-agent thinkingDefault fills the gap when the entry has no thinkingLevel", () => {
    const cfg = makeCfg({ agentEntry: { thinkingDefault: "high" } });
    const [row] = listSingleMainSession(cfg, {});
    expect(row?.thinkingLevel).toBe("high");
  });

  test("global agents.defaults.thinkingDefault fills the gap when per-agent is unset", () => {
    const cfg = makeCfg({ agentEntry: {}, defaultsThinkingDefault: "low" });
    const [row] = listSingleMainSession(cfg, {});
    expect(row?.thinkingLevel).toBe("low");
  });

  test("model-centric fallback still produces a concrete ThinkLevel string (never undefined)", () => {
    const cfg = makeCfg({
      agentEntry: { model: "openai-codex/gpt-5.4" /* no thinkingDefault */ },
    });
    const [row] = listSingleMainSession(cfg, {
      model: "gpt-5.4",
      modelProvider: "openai-codex",
    });
    expect(typeof row?.thinkingLevel).toBe("string");
    expect((row?.thinkingLevel as string).length).toBeGreaterThan(0);
  });

  test("sessions.list and loadGatewaySessionRow stay consistent on thinkingLevel", async () => {
    const cfg = makeCfg({ agentEntry: { thinkingDefault: "high" } });

    // sessions.list path — in-memory, no state dir required.
    const [fromListRow] = listSingleMainSession(cfg, {});
    expect(fromListRow?.thinkingLevel).toBe("high");

    // loadGatewaySessionRow path — same config, seeded through the state-dir
    // pipeline so the live RPC behavior (used by sessions.changed broadcasts)
    // is exercised too.
    await withStateDirEnv("session-utils-think-fallback-consistency-", async ({ stateDir }) => {
      const sessionsDir = path.join(stateDir, "agents", "main", "sessions");
      fs.mkdirSync(sessionsDir, { recursive: true });
      const storePath = path.join(sessionsDir, "sessions.json");
      fs.writeFileSync(
        storePath,
        JSON.stringify({
          "agent:main:main": { sessionId: "sess-consistency", updatedAt: Date.now() },
        }),
        "utf8",
      );
      setRuntimeConfigSnapshot(cfg, cfg);
      const fromLoad = loadGatewaySessionRow("agent:main:main");
      expect(fromLoad?.thinkingLevel).toBe("high");
      expect(fromLoad?.thinkingLevel).toBe(fromListRow?.thinkingLevel);
    });
  });

  test("canonical webchat sessionKey 'agent:main:main' resolves via normalized agent lookup", () => {
    const cfg = makeCfg({ agentEntry: { thinkingDefault: "high" } });
    const storePath = "/tmp/sessions-utils-thinking-fallback-canonical.json";
    const result = listSessionsFromStore({
      cfg,
      storePath,
      store: {
        "agent:main:main": {
          sessionId: "sess-canonical",
          updatedAt: Date.now(),
        } as SessionEntry,
      },
      opts: {},
    });
    const row = result.sessions.find((r) => r.key === "agent:main:main");
    expect(row?.thinkingLevel).toBe("high");
  });
});
