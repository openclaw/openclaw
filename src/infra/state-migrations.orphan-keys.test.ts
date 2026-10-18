// Tests migration cleanup for orphaned state keys.
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { EMPTY_LEGACY_SESSION_SURFACES } from "../plugins/legacy-session-surfaces.types.js";
import {
  migrateOrphanedSessionKeys,
  resolveSessionStoreOwnership,
} from "./state-migrations.session-store.js";

const listPluginDoctorSessionStoreAgentIdsMock = vi.hoisted(() => vi.fn((): string[] => []));

vi.mock("../plugins/doctor-contract-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../plugins/doctor-contract-registry.js")>();
  return {
    ...actual,
    listPluginDoctorSessionStoreAgentIds: listPluginDoctorSessionStoreAgentIdsMock,
  };
});

function writeStore(storePath: string, store: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(store));
}

function readStore(storePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(storePath, "utf-8"));
}

function sessionId(store: Record<string, unknown>, key: string): string {
  const entry = store[key] as { sessionId?: unknown; updatedAt?: number } | undefined;
  if (!entry || typeof entry.sessionId !== "string") {
    throw new Error(`expected session store entry ${key}`);
  }
  return entry.sessionId;
}

const entry = (id: string, updatedAt: number) => ({ sessionId: id, updatedAt });

const OPS_WORK_CONFIG = {
  session: { mainKey: "work" },
  agents: { entries: { ops: {} } },
} as OpenClawConfig;

function opsSessionStorePath(stateDir: string): string {
  return path.join(stateDir, "agents", "ops", "sessions", "sessions.json");
}

function sharedMainOpsConfig(sharedStorePath: string): OpenClawConfig {
  return {
    session: { mainKey: "work", store: sharedStorePath },
    agents: { entries: { main: {}, ops: {} } },
  } as OpenClawConfig;
}

async function migrateFixtureState(
  stateDir: string,
  cfg: OpenClawConfig = OPS_WORK_CONFIG,
  additionalAgentIds?: readonly string[],
) {
  return migrateOrphanedSessionKeys({
    cfg,
    env: { OPENCLAW_STATE_DIR: stateDir },
    additionalAgentIds,
    legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
  });
}

describe("migrateOrphanedSessionKeys", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let tmpDir: string;
  let stateDir: string;
  beforeEach(() => {
    tmpDir = tempDirs.make("orphan-keys-test-");
    stateDir = path.join(tmpDir, ".openclaw");
    fs.mkdirSync(stateDir, { recursive: true });
  });
  beforeEach(() => {
    listPluginDoctorSessionStoreAgentIdsMock.mockReset();
    listPluginDoctorSessionStoreAgentIdsMock.mockReturnValue([]);
  });

  it("promotes legacy voice sessions before canonical runtime access", async () => {
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    writeStore(storePath, {
      "voice:15550001111": entry("legacy-voice", 2_000),
      "agent:main:voice:15550001111": entry("stale-canonical", 1_000),
    });

    await migrateFixtureState(stateDir, {} as OpenClawConfig);

    const store = readStore(storePath);
    expect(sessionId(store, "agent:main:voice:15550001111")).toBe("legacy-voice");
    expect(store["voice:15550001111"]).toBeUndefined();
  });

  it("distinguishes large adjacent inodes before planning store aliases", async () => {
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    const targetStorePath = path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
    writeStore(configuredStorePath, {});
    writeStore(targetStorePath, {});
    const cfg = {
      session: { store: configuredStorePath },
      agents: { entries: { ops: {} } },
    } as OpenClawConfig;
    const realStatSync = fs.statSync.bind(fs);
    const largeInodes = new Map([
      [configuredStorePath, 72057594037932382n],
      [targetStorePath, 72057594037932383n],
    ]);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation(((
      candidate: Parameters<typeof fs.statSync>[0],
      options?: { bigint?: boolean },
    ) => {
      const resolvedPath = path.resolve(candidate.toString());
      const inode = largeInodes.get(resolvedPath);
      const useBigInt = options?.bigint === true;
      const stat = useBigInt ? realStatSync(candidate, { bigint: true }) : realStatSync(candidate);
      if (inode === undefined) {
        return stat;
      }
      return new Proxy(stat, {
        get(target, property, receiver) {
          if (property === "dev") {
            return useBigInt ? 2n : 2;
          }
          if (property === "ino") {
            return useBigInt ? inode : Number(inode);
          }
          return Reflect.get(target, property, receiver);
        },
      });
    }) as typeof fs.statSync);

    let ownership: ReturnType<typeof resolveSessionStoreOwnership>;
    try {
      ownership = resolveSessionStoreOwnership({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        stateDir,
        targetAgentId: "voice",
        pluginSessionStoreAgentIds: ["voice"],
      });
      expect(statSpy).toHaveBeenCalledWith(configuredStorePath, { bigint: true });
      expect(statSpy).toHaveBeenCalledWith(targetStorePath, { bigint: true });
    } finally {
      statSpy.mockRestore();
    }

    expect(ownership).toEqual({
      preserveAmbiguousKeys: false,
      preserveForeignMainAliases: false,
      targetStoreAliases: {
        hasDistinctAliases: false,
        hasFinalSymlink: false,
        hasUnresolvedIdentity: false,
      },
    });
  });

  it.each([
    { scope: undefined, canonicalMainKey: "agent:voice:main" },
    { scope: "global" as const, canonicalMainKey: "global" },
  ])(
    "preserves opaque foreign main aliases in plugin-owned $scope stores",
    async ({ scope, canonicalMainKey }) => {
      const storeTemplate = path.join(tmpDir, "stores", "{agentId}", "sessions.json");
      const voiceStorePath = path.join(tmpDir, "stores", "voice", "sessions.json");
      writeStore(voiceStorePath, {
        "agent:main:main": entry("explicit-foreign", 3000),
        [canonicalMainKey]: entry("voice-main", 1000),
        "voice:15550001111": entry("legacy-voice", 2000),
      });
      const cfg = {
        session: { store: storeTemplate, scope },
        agents: { entries: { main: {} } },
        plugins: {
          entries: {
            "voice-call": { config: { agentId: "voice" } },
          },
        },
      } as OpenClawConfig;

      const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

      const store = readStore(voiceStorePath);
      expect(sessionId(store, "agent:main:main")).toBe("explicit-foreign");
      expect(sessionId(store, canonicalMainKey)).toBe("voice-main");
      expect(sessionId(store, "agent:voice:voice:15550001111")).toBe("legacy-voice");
      expect(store["voice:15550001111"]).toBeUndefined();
      expect(result.changes).toHaveLength(1);
      expect(result.warnings).toHaveLength(1);
    },
  );

  it("warns from a readable alias when the configured path identity is inaccessible", async () => {
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    writeStore(configuredStorePath, {});
    const standardStorePath = path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
    writeStore(standardStorePath, {
      "voice:15550001111": entry("legacy-voice", 1000),
    });
    const cfg = {
      session: { store: configuredStorePath },
      agents: { entries: { ops: {} } },
    } as OpenClawConfig;
    const realStatSync = fs.statSync.bind(fs);
    const statSpy = vi.spyOn(fs, "statSync").mockImplementation((candidate) => {
      if (path.resolve(candidate.toString()) === configuredStorePath) {
        throw Object.assign(new Error("inaccessible store"), { code: "EACCES" });
      }
      return realStatSync(candidate);
    });

    let result: Awaited<ReturnType<typeof migrateOrphanedSessionKeys>>;
    try {
      result = await migrateOrphanedSessionKeys({
        cfg,
        env: { OPENCLAW_STATE_DIR: stateDir },
        additionalAgentIds: ["voice"],
        legacySessionSurfaces: EMPTY_LEGACY_SESSION_SURFACES,
      });
    } finally {
      statSpy.mockRestore();
    }

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred session key migration for ${standardStorePath}; filesystem identity could not be established for every configured store path. Restore path access or configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
    expect(sessionId(readStore(standardStorePath), "voice:15550001111")).toBe("legacy-voice");
  });

  it("defers migration through a final-component store symlink", async () => {
    const standardStorePath = path.join(stateDir, "agents", "voice", "sessions", "sessions.json");
    writeStore(standardStorePath, {
      "agent:voice::matrix:channel:!room:example.org": {
        sessionId: "malformed-owner",
        updatedAt: 2000,
      },
      "voice:15550001111": entry("legacy-voice", 1000),
    });
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    fs.symlinkSync(standardStorePath, configuredStorePath);
    const cfg = {
      session: { store: configuredStorePath },
      agents: { entries: { ops: {} } },
      plugins: {
        entries: {
          "voice-call": { config: { agentId: "voice" } },
        },
      },
    } as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg, ["voice"]);

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred migration of 2 ambiguous session key(s) in aliased store ${configuredStorePath}; remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
    expect(fs.lstatSync(configuredStorePath).isSymbolicLink()).toBe(true);
    expect(
      sessionId(readStore(standardStorePath), "agent:voice::matrix:channel:!room:example.org"),
    ).toBe("malformed-owner");
  });

  it("defers an unambiguous rewrite through a singleton final symlink", async () => {
    const outsideStorePath = path.join(tmpDir, "outside-sessions.json");
    writeStore(outsideStorePath, {
      "agent:main:main": entry("outside-global", 1000),
    });
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.symlinkSync(outsideStorePath, storePath);
    const cfg = { session: { scope: "global" } } as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg);

    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred session key migration in final-component symlink store ${storePath}; configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
    expect(fs.lstatSync(storePath).isSymbolicLink()).toBe(true);
    expect(sessionId(readStore(outsideStorePath), "agent:main:main")).toBe("outside-global");
  });

  it("defers global main aliases across hard-linked store paths", async () => {
    const standardStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    writeStore(standardStorePath, {
      "agent:main:main": entry("legacy-global", 1000),
    });
    const configuredStorePath = path.join(tmpDir, "configured-sessions.json");
    fs.linkSync(standardStorePath, configuredStorePath);
    const cfg = {
      session: { scope: "global", store: configuredStorePath },
      agents: { entries: { main: {} } },
    } as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg);

    for (const storePath of [configuredStorePath, standardStorePath]) {
      expect(sessionId(readStore(storePath), "agent:main:main")).toBe("legacy-global");
      expect(readStore(storePath).global).toBeUndefined();
    }
    expect(result.changes).toHaveLength(0);
    expect(result.warnings).toEqual([
      `Deferred session key migration in aliased store ${configuredStorePath}; atomic replacement cannot update distinct filesystem aliases as one operation. Remove filesystem aliases or configure one canonical session.store path, then rerun openclaw doctor --fix`,
    ]);
  });

  it("keeps the newest entry and prefers canonical keys on ties in either source order", async () => {
    const storePath = opsSessionStorePath(stateDir);
    writeStore(storePath, {
      "agent:main:main": entry("old-orphan", 500),
      "agent:ops:work": entry("current", 2000),
      "agent:ops:TIE-ONE": entry("noncanonical-earlier", 1000),
      "agent:ops:tie-one": entry("canonical-later", 1000),
      "agent:ops:tie-two": entry("canonical-earlier", 1000),
      "agent:ops:TIE-TWO": entry("noncanonical-later", 1000),
    });

    await migrateFixtureState(stateDir);

    const store = readStore(storePath);
    expect((store["agent:ops:work"] as { sessionId: string }).sessionId).toBe("current");
    expect(store["agent:main:main"]).toBeUndefined();
    expect(sessionId(store, "agent:ops:tie-one")).toBe("canonical-later");
    expect(sessionId(store, "agent:ops:tie-two")).toBe("canonical-earlier");
    expect(store["agent:ops:TIE-ONE"]).toBeUndefined();
    expect(store["agent:ops:TIE-TWO"]).toBeUndefined();
  });

  it("preserves the exact bytes of commented JSON5 with trailing commas", async () => {
    const raw = `// operator-authored session history\n{\n  'agent:ops:work': { sessionId: 'abc-123', updatedAt: 1000, },\n}\n`;
    const storePath = opsSessionStorePath(stateDir);
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, raw);

    expect(await migrateFixtureState(stateDir)).toEqual({ changes: [], warnings: [] });
    expect(fs.readFileSync(storePath, "utf-8")).toBe(raw);
  });

  it("checks missing agent stores without comparing every earlier path", async () => {
    const agentCount = 100;
    const cfg = {
      session: { store: path.join(tmpDir, "stores", "{agentId}", "sessions.json") },
      agents: {
        entries: Object.fromEntries(
          Array.from({ length: agentCount }, (_, index) => [`agent-${index}`, {}]),
        ),
      },
    } as OpenClawConfig;
    const statSpy = vi.spyOn(fs, "statSync");

    try {
      expect(await migrateFixtureState(stateDir, cfg)).toEqual({ changes: [], warnings: [] });
      const storeProbes = statSpy.mock.calls.filter(([candidate]) =>
        candidate.toString().endsWith("sessions.json"),
      );
      expect(storeProbes).toHaveLength(agentCount);
    } finally {
      statSpy.mockRestore();
    }
  });

  it("does not prepare channel migration surfaces without a legacy store", async () => {
    const prepareLegacySessionSurfaces = vi.fn(() => EMPTY_LEGACY_SESSION_SURFACES);

    const result = await migrateOrphanedSessionKeys({
      cfg: OPS_WORK_CONFIG,
      env: { OPENCLAW_STATE_DIR: stateDir },
      legacySessionSurfaces: prepareLegacySessionSurfaces,
    });

    expect(result).toEqual({ changes: [], warnings: [] });
    expect(prepareLegacySessionSurfaces).not.toHaveBeenCalled();
  });

  it("preserves legacy default-main aliases in shared stores", async () => {
    // When session.store lacks {agentId}, all agents resolve to the same file.
    // The "main" agent's keys must not be remapped into the "ops" namespace.
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    writeStore(sharedStorePath, {
      "agent:main:main": entry("main-session", 2000),
      "agent:ops:work": entry("ops-session", 1000),
    });

    const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

    const store = readStore(sharedStorePath);
    expect(sessionId(store, "agent:main:main")).toBe("main-session");
    expect(store["agent:main:work"]).toBeUndefined();
    expect(sessionId(store, "agent:ops:work")).toBe("ops-session");
    expect(result.warnings).toHaveLength(1);
  });

  it("canonicalizes global main aliases in shared stores", async () => {
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    writeStore(sharedStorePath, {
      global: entry("stale-global", 1000),
      main: entry("bare-main", 2000),
      "agent:main:main": entry("legacy-main", 3000),
      "agent:main:work": entry("fresh-main", 4000),
    });
    const cfg = {
      session: { scope: "global", mainKey: "work", store: sharedStorePath },
      agents: { entries: { main: {}, ops: {} } },
    } as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg);

    const store = readStore(sharedStorePath);
    expect(sessionId(store, "global")).toBe("fresh-main");
    expect(store.main).toBeUndefined();
    expect(store["agent:main:main"]).toBeUndefined();
    expect(store["agent:main:work"]).toBeUndefined();
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("canonicalizes non-main shared rows within their declared owners", async () => {
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    writeStore(sharedStorePath, {
      "agent:ops:main": entry("ops-session", 1000),
      "agent:research:main": entry("research-session", 2000),
    });
    const cfg = {
      session: { mainKey: "work", store: sharedStorePath },
      agents: { entries: { ops: {}, research: {} } },
    } as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg);

    const store = readStore(sharedStorePath);
    expect(sessionId(store, "agent:ops:work")).toBe("ops-session");
    expect(sessionId(store, "agent:research:work")).toBe("research-session");
    expect(store["agent:ops:main"]).toBeUndefined();
    expect(store["agent:research:main"]).toBeUndefined();
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it("does not guess the owner of raw keys in shared multi-agent stores", async () => {
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    writeStore(sharedStorePath, {
      "voice:15550001111": entry("legacy-voice", 2000),
      "agent:ops:work": entry("ops-session", 1000),
    });

    const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

    const store = readStore(sharedStorePath);
    expect(sessionId(store, "voice:15550001111")).toBe("legacy-voice");
    expect(store["agent:main:voice:15550001111"]).toBeUndefined();
    expect(store["agent:ops:voice:15550001111"]).toBeUndefined();
    expect(result.warnings).toContain(
      `Preserved 1 ambiguous session key(s) in potentially shared store ${sharedStorePath}`,
    );
  });

  it("uses the persisted owner for raw keys in a fixed multi-agent store", async () => {
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    writeStore(sharedStorePath, {
      "voice:15550001111": entry("legacy-voice", 2000),
    });
    const cfg = {
      session: { mainKey: "work", store: sharedStorePath },
      agents: {
        ownership: "explicit",
        defaults: { sessionStore: { agentId: "ops" } },
        entries: { main: {}, ops: {} },
      },
    } as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg);

    const store = readStore(sharedStorePath);
    expect(sessionId(store, "agent:ops:voice:15550001111")).toBe("legacy-voice");
    expect(store["voice:15550001111"]).toBeUndefined();
    expect(result.warnings).toHaveLength(0);
  });

  it("preserves prototype-shaped keys when another shared-store row migrates", async () => {
    const sharedStorePath = path.join(tmpDir, "shared-sessions.json");
    const source = {
      ["__proto__"]: entry("prototype-session", 1000),
      "agent:ops:main": entry("ops-session", 2000),
    };
    writeStore(sharedStorePath, source);

    const result = await migrateFixtureState(stateDir, sharedMainOpsConfig(sharedStorePath));

    const store = readStore(sharedStorePath);
    expect(Object.hasOwn(store, "__proto__")).toBe(true);
    expect(sessionId(store, "__proto__")).toBe("prototype-session");
    expect(sessionId(store, "agent:ops:work")).toBe("ops-session");
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
  });

  it("canonicalizes mixed-case scoped main aliases on the first run", async () => {
    const storePath = opsSessionStorePath(stateDir);
    writeStore(storePath, {
      "Agent:OPS:MAIN": entry("ops-session", 2000),
    });

    const first = await migrateFixtureState(stateDir);
    const second = await migrateFixtureState(stateDir);

    const store = readStore(storePath);
    expect(sessionId(store, "agent:ops:work")).toBe("ops-session");
    expect(store["Agent:OPS:MAIN"]).toBeUndefined();
    expect(first.changes).toHaveLength(1);
    expect(second).toEqual({ changes: [], warnings: [] });
  });

  it("no-ops when default agentId is main and mainKey is main", async () => {
    const storePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
    writeStore(storePath, {
      "agent:main:main": entry("abc-123", 1000),
    });

    const cfg = {} as OpenClawConfig;

    const result = await migrateFixtureState(stateDir, cfg);

    expect(result.changes).toHaveLength(0);
    const store = readStore(storePath);
    expect(sessionId(store, "agent:main:main")).toBe("abc-123");
  });
});
