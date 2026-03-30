import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, vi, type Mock } from "vitest";

type HomeEnvSnapshot = {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  HOMEDRIVE: string | undefined;
  HOMEPATH: string | undefined;
  NEXUS_STATE_DIR: string | undefined;
  NEXUS_AGENT_DIR: string | undefined;
  PI_CODING_AGENT_DIR: string | undefined;
};

function snapshotHomeEnv(): HomeEnvSnapshot {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    NEXUS_STATE_DIR: process.env.NEXUS_STATE_DIR,
    NEXUS_AGENT_DIR: process.env.NEXUS_AGENT_DIR,
    PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  };
}

function restoreHomeEnv(snapshot: HomeEnvSnapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function createTempHomeHarness(options: { prefix: string; beforeEachCase?: () => void }) {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), options.prefix));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
    const home = path.join(fixtureRoot, `case-${++caseId}`);
    await fs.mkdir(path.join(home, ".nexus-agent", "agents", "main", "sessions"), { recursive: true });
    const envSnapshot = snapshotHomeEnv();
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    process.env.NEXUS_STATE_DIR = path.join(home, ".nexus-agent");
    process.env.NEXUS_AGENT_DIR = path.join(home, ".nexus-agent", "agent");
    process.env.PI_CODING_AGENT_DIR = path.join(home, ".nexus-agent", "agent");

    if (process.platform === "win32") {
      const match = home.match(/^([A-Za-z]:)(.*)$/);
      if (match) {
        process.env.HOMEDRIVE = match[1];
        process.env.HOMEPATH = match[2] || "\\";
      }
    }

    try {
      options.beforeEachCase?.();
      return await fn(home);
    } finally {
      restoreHomeEnv(envSnapshot);
    }
  }

  return { withTempHome };
}

export function makeReplyConfig(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    session: { store: path.join(home, "sessions.json") },
  };
}

export type ReplyRuntimeMocks = {
  runEmbeddedPiAgent: Mock;
  loadModelCatalog: Mock;
  webAuthExists: Mock;
  getWebAuthAgeMs: Mock;
  readWebSelfId: Mock;
};

export function createReplyRuntimeMocks(): ReplyRuntimeMocks {
  return {
    runEmbeddedPiAgent: vi.fn(),
    loadModelCatalog: vi.fn(),
    webAuthExists: vi.fn().mockResolvedValue(true),
    getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
    readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
  };
}

export function installReplyRuntimeMocks(mocks: ReplyRuntimeMocks) {
  vi.mock("../agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
    runEmbeddedPiAgent: (...args: unknown[]) => mocks.runEmbeddedPiAgent(...args),
    queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
    isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
  }));

  vi.mock("../agents/model-catalog.runtime.js", () => ({
    loadModelCatalog: mocks.loadModelCatalog,
  }));

  vi.mock("../agents/auth-profiles/session-override.js", () => ({
    clearSessionAuthProfileOverride: vi.fn(),
    resolveSessionAuthProfileOverride: vi.fn().mockResolvedValue(undefined),
  }));

  vi.mock("../commands-registry.runtime.js", () => ({
    listChatCommands: () => [],
  }));

  vi.mock("../skill-commands.runtime.js", () => ({
    listSkillCommandsForWorkspace: () => [],
  }));

  vi.mock("../plugins/runtime/runtime-whatsapp-boundary.js", () => ({
    webAuthExists: mocks.webAuthExists,
    getWebAuthAgeMs: mocks.getWebAuthAgeMs,
    readWebSelfId: mocks.readWebSelfId,
  }));
}

export function resetReplyRuntimeMocks(mocks: ReplyRuntimeMocks) {
  mocks.runEmbeddedPiAgent.mockClear();
  mocks.loadModelCatalog.mockClear();
  mocks.loadModelCatalog.mockResolvedValue([
    { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
  ]);
}

export function makeEmbeddedTextResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}
