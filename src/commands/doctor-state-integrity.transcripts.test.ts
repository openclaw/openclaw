import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INTERNAL_WAKE_TRANSCRIPT_PROMPTS } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSessionStorePathCore,
  resolveSessionTranscriptsDirForAgent,
} from "../config/sessions/paths.js";
import {
  listSessionEntryKeysReadOnly,
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
} from "../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
} from "../state/openclaw-state-db.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { readTuiLastSessionKey, writeTuiLastSessionKey } from "../tui/tui-last-session.js";
import { repairHeartbeatPoisonedMainSession } from "./doctor-heartbeat-main-session-repair.js";
import {
  doctorChangesText,
  hasRepairPromptMessage,
  noteMock,
  noteStateIntegrity,
  setupSessionState,
  stateIntegrityText,
  writeSessionStore,
} from "./doctor-state-integrity.test-support.js";

vi.mock("../channels/plugins/bundled-ids.js", () => ({
  listBundledChannelIds: () => ["matrix", "whatsapp"],
  listBundledChannelPluginIds: () => ["matrix", "whatsapp"],
}));
vi.mock("../channels/plugins/persisted-auth-state.js", () => ({
  listBundledChannelIdsWithPersistedAuthState: () => ["matrix", "whatsapp"],
  hasBundledChannelPersistedAuthState: () => false,
}));
const routeStateOwnerState = vi.hoisted(() => ({ owners: [] as Array<Record<string, unknown>> }));
vi.mock("../plugins/doctor-contract-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../plugins/doctor-contract-registry.js")>(
    "../plugins/doctor-contract-registry.js",
  );
  return {
    ...actual,
    listPluginDoctorSessionRouteStateOwners: vi.fn(() => routeStateOwnerState.owners),
  };
});

describe("doctor transcript and heartbeat session repairs", () => {
  let envSnapshot: ReturnType<typeof captureEnv>;
  let tempHome = "";
  let stateDir = "";
  const mainKey = "agent:main:main";
  const heartbeatLine = `${JSON.stringify({ message: { role: "user", content: INTERNAL_WAKE_TRANSCRIPT_PROMPTS.heartbeat } })}\n${JSON.stringify({ message: { role: "assistant", content: "HEARTBEAT_OK" } })}\n`;
  const approveMove = vi.fn(async ({ message }: { message: string }) =>
    message.startsWith("Move heartbeat-owned main session"),
  );
  const run = (cfg: OpenClawConfig = {}) =>
    noteStateIntegrity(cfg, { confirmRuntimeRepair: approveMove, note: noteMock });
  const readLegacy = () =>
    JSON.parse(
      fs.readFileSync(resolveSessionStorePathCore(undefined, { agentId: "main" }), "utf8"),
    ) as Record<string, SessionEntry>;
  function legacyMain(transcript: string, entry: Partial<SessionEntry> = {}) {
    writeSessionStore({}, { [mainKey]: { sessionId: "session", updatedAt: 1, ...entry } });
    const transcriptPath = path.join(
      resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome),
      "session.jsonl",
    );
    fs.writeFileSync(transcriptPath, transcript);
    return transcriptPath;
  }
  async function sqliteMain(
    entry: Partial<SessionEntry> = {},
    cfg: OpenClawConfig = { agents: { entries: { main: {}, ops: {} } } },
  ) {
    setupSessionState(cfg, process.env, tempHome, "ops");
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "ops" });
    const key = "agent:ops:main";
    await upsertSessionEntryCore(
      { agentId: "ops", sessionKey: key, storePath },
      {
        sessionId: "sqlite-heartbeat-ops",
        updatedAt: 1,
        heartbeatIsolatedBaseSessionKey: key,
        ...entry,
      },
    );
    return { cfg, storePath, key };
  }

  beforeEach(() => {
    envSnapshot = captureEnv([
      "HOME",
      "OPENCLAW_HOME",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_OAUTH_DIR",
      "OPENCLAW_AGENT_DIR",
    ]);
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-doctor-state-integrity-"));
    stateDir = path.join(tempHome, ".openclaw");
    setTestEnvValue("HOME", tempHome);
    setTestEnvValue("OPENCLAW_HOME", tempHome);
    setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
    deleteTestEnvValue("OPENCLAW_OAUTH_DIR");
    deleteTestEnvValue("OPENCLAW_AGENT_DIR");
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    routeStateOwnerState.owners = [];
    noteMock.mockClear();
    approveMove.mockClear();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    envSnapshot.restore();
    fs.rmSync(tempHome, { recursive: true, force: true });
  });

  it("leaves legacy transcript diagnostics to the SQLite migration owner", async () => {
    writeSessionStore(
      {},
      {
        "agent:main:main:heartbeat": {
          heartbeatIsolatedBaseSessionKey: mainKey,
          sessionId: "latest-heartbeat-wake",
          updatedAt: 1,
        },
      },
    );
    const displaced = path.join(
      resolveSessionTranscriptsDirForAgent("main", process.env, () => tempHome),
      "displaced-heartbeat-wake.jsonl",
    );
    fs.writeFileSync(displaced, '{"type":"session"}\n');
    await run();
    expect(stateIntegrityText()).not.toContain("recent sessions are missing transcripts");
    expect(stateIntegrityText()).not.toContain("orphan transcript file");
    expect(fs.existsSync(displaced)).toBe(true);
    expect(approveMove).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("Archive 1 orphan") }),
    );
  });

  it("does not require JSONL files for an explicit SQLite store", async () => {
    const cfg: OpenClawConfig = {
      session: { store: path.join(fs.realpathSync(tempHome), "sessions.sqlite") },
    };
    setupSessionState(cfg, process.env, tempHome);
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: "main" });
    for (const key of [mainKey, "agent:main:sqlite-only"]) {
      await upsertSessionEntryCore(
        { agentId: "main", sessionKey: key, storePath },
        { sessionId: key === mainKey ? "sqlite-main" : "sqlite-only", updatedAt: 1 },
      );
    }
    const readFile = vi.spyOn(fs, "readFileSync");
    await run(cfg);
    expect(readFile.mock.calls.map(([file]) => file)).not.toContain(storePath);
    expect(stateIntegrityText()).not.toContain("recent sessions are missing transcripts");
    expect(stateIntegrityText()).not.toContain("Main session transcript missing");
  });

  it("does not create a recovery row when SQLite main changes during confirmation", async () => {
    const { cfg, storePath, key } = await sqliteMain();
    await noteStateIntegrity(cfg, {
      confirmRuntimeRepair: async ({ message }) => {
        if (!message.startsWith("Move heartbeat-owned main session")) {
          return false;
        }
        await upsertSessionEntryCore(
          { agentId: "ops", sessionKey: key, storePath },
          { lastInteractionAt: 2, updatedAt: 2 },
        );
        return true;
      },
      note: noteMock,
    });
    expect(await listSessionEntryKeysReadOnly({ agentId: "ops", storePath })).toEqual([key]);
    expect(
      loadSessionEntryReadOnly({ agentId: "ops", sessionKey: key, storePath })?.lastInteractionAt,
    ).toBe(2);
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("moves a non-default plugin-repaired SQLite row without restoring stale state or sessions.json", async () => {
    routeStateOwnerState.owners = [
      {
        authProfilePrefixes: ["openai-codex:"],
        cliSessionKeys: ["codex-cli"],
        id: "codex",
        label: "Codex",
        providerIds: ["openai-codex"],
        runtimeIds: ["codex-cli"],
      },
    ];
    const { cfg, storePath, key } = await sqliteMain(
      {
        model: "gpt-5.4",
        modelOverride: "gpt-5.4",
        modelOverrideSource: "auto",
        modelProvider: "openai-codex",
        providerOverride: "openai-codex",
      },
      {
        agents: {
          defaults: { model: { primary: "github-copilot/gpt-5.4-mini" } },
          entries: { main: {}, ops: {} },
        },
      },
    );
    await noteStateIntegrity(cfg, {
      confirmRuntimeRepair: async ({ message }) =>
        message.startsWith("Clear stale Codex") ||
        message.startsWith("Move heartbeat-owned main session"),
      note: noteMock,
    });
    const keys = await listSessionEntryKeysReadOnly({ agentId: "ops", storePath });
    expect(keys).not.toContain(key);
    const recovered = keys.filter((candidate) =>
      candidate.startsWith("agent:ops:heartbeat-recovered-"),
    );
    expect(recovered).toHaveLength(1);
    const recoveredKey = recovered[0];
    if (!recoveredKey) {
      throw new Error("expected recovered SQLite session");
    }
    const entry = loadSessionEntryReadOnly({ agentId: "ops", sessionKey: recoveredKey, storePath });
    expect(entry?.sessionId).toBe("sqlite-heartbeat-ops");
    expect(entry?.providerOverride).toBeUndefined();
    expect(entry?.modelOverride).toBeUndefined();
    expect(entry?.modelProvider).toBeUndefined();
    expect(fs.existsSync(storePath)).toBe(false);
  });

  it("repairs a multi-chunk transcript and clears only matching TUI pointers without reading the whole file", async () => {
    const repeats = Math.ceil((80 * 1024) / heartbeatLine.length);
    const transcriptPath = legacyMain(heartbeatLine.repeat(repeats));
    expect(fs.statSync(transcriptPath).size).toBeGreaterThan(64 * 1024);
    await writeTuiLastSessionKey({ scopeKey: "default", sessionKey: mainKey, stateDir });
    await writeTuiLastSessionKey({
      scopeKey: "telegram",
      sessionKey: "agent:main:telegram:thread",
      stateDir,
    });
    const readFile = vi.spyOn(fs, "readFileSync");
    await run();
    expect(readFile.mock.calls.map(([file]) => file)).not.toContain(transcriptPath);
    expect(stateIntegrityText()).toContain(`${repeats} heartbeat-only user message(s)`);
    const store = readLegacy();
    expect(store[mainKey]).toBeUndefined();
    const recovered = Object.entries(store).filter(([key]) =>
      key.startsWith("agent:main:heartbeat-recovered-"),
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.[1].sessionId).toBe("session");
    await expect(readTuiLastSessionKey({ scopeKey: "default", stateDir })).resolves.toBeNull();
    await expect(readTuiLastSessionKey({ scopeKey: "telegram", stateDir })).resolves.toBe(
      "agent:main:telegram:thread",
    );
    expect(doctorChangesText()).toContain("Moved heartbeat-owned main session agent:main:main");
    expect(doctorChangesText()).toContain("Cleared 1 stale TUI last-session pointer");
  });

  it("preserves real user activity after 400 heartbeat turns even with synthetic ownership metadata", async () => {
    legacyMain(
      `${heartbeatLine.repeat(400)}${JSON.stringify({ message: { role: "user", content: "real follow-up" } })}\n`,
      { heartbeatIsolatedBaseSessionKey: mainKey },
    );
    await run();
    expect(readLegacy()[mainKey]?.sessionId).toBe("session");
    expect(Object.keys(readLegacy()).filter((key) => key.includes("heartbeat-recovered"))).toEqual(
      [],
    );
    expect(hasRepairPromptMessage(approveMove, "Move heartbeat-owned main session")).toBe(false);
  });

  it("declines repair when a JSONL record exceeds the streaming scanner cap", async () => {
    // Independent bound from the streaming-scan regression (#110721).
    const maxChars = 256 * 1024;
    const transcriptPath = legacyMain(`${"x".repeat(maxChars + 1)}\n${heartbeatLine}`);
    const readFile = vi.spyOn(fs, "readFileSync");
    await run();
    expect(readFile.mock.calls.map(([file]) => file)).not.toContain(transcriptPath);
    expect(stateIntegrityText()).toContain(
      `Skipped heartbeat main-session recovery for agent:main:main: the transcript contains a JSONL record larger than ${maxChars} characters, so doctor left it unchanged.`,
    );
    expect(hasRepairPromptMessage(approveMove, "Move heartbeat-owned main session")).toBe(false);
    expect(readLegacy()[mainKey]?.sessionId).toBe("session");
    expect(Object.keys(readLegacy()).filter((key) => key.includes("heartbeat-recovered"))).toEqual(
      [],
    );
  });

  it.each([
    { name: "routing metadata", entry: { delivery: { kind: "internal" } }, prompts: false },
    {
      name: "synthetic ownership",
      entry: { heartbeatIsolatedBaseSessionKey: mainKey },
      prompts: true,
    },
    {
      name: "human interaction",
      entry: { heartbeatIsolatedBaseSessionKey: mainKey, lastInteractionAt: 2 },
      prompts: false,
    },
  ] satisfies Array<{ name: string; entry: Partial<SessionEntry>; prompts: boolean }>)(
    "requires consent and ownership without human activity ($name)",
    async ({ entry, prompts }) => {
      const warnings: string[] = [],
        changes: string[] = [];
      const storePath = path.join(tempHome, "unwritten-repair-store.json");
      const confirmRuntimeRepair = vi.fn(async () => false);
      await expect(
        repairHeartbeatPoisonedMainSession({
          mainKey,
          mainEntry: { sessionId: "session", updatedAt: 1, ...entry },
          isSessionKeyOccupied: () => false,
          store: { kind: "legacy", path: storePath },
          stateDir,
          sessionPathOpts: { agentId: "main", sessionsDir: tempHome },
          prompter: { confirmRuntimeRepair },
          warnings,
          changes,
        }),
      ).resolves.toBe(false);
      expect(confirmRuntimeRepair).toHaveBeenCalledTimes(prompts ? 1 : 0);
      if (prompts) {
        expect(warnings.join("\n")).toContain("(heartbeat metadata)");
      }
      expect(changes).toEqual([]);
      expect(fs.existsSync(storePath)).toBe(false);
    },
  );
});
