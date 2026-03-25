import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";

const agentMocks = vi.hoisted(() => ({
  runEmbeddedPiAgent: vi.fn(),
  loadModelCatalog: vi.fn(),
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: (...args: unknown[]) => agentMocks.runEmbeddedPiAgent(...args),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

vi.mock("../agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: agentMocks.loadModelCatalog,
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

vi.mock("../../extensions/whatsapp/src/session.js", () => ({
  webAuthExists: agentMocks.webAuthExists,
  getWebAuthAgeMs: agentMocks.getWebAuthAgeMs,
  readWebSelfId: agentMocks.readWebSelfId,
}));

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;

function makeResult(text: string) {
  return {
    payloads: [{ text }],
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  };
}

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(
    async (home) => {
      agentMocks.runEmbeddedPiAgent.mockClear();
      return await fn(home);
    },
    {
      env: {
        OPENCLAW_BUNDLED_SKILLS_DIR: (home) => path.join(home, "bundled-skills"),
      },
      prefix: "openclaw-media-note-",
    },
  );
}

function makeCfg(home: string) {
  return {
    agents: {
      defaults: {
        model: "anthropic/claude-opus-4-5",
        workspace: path.join(home, "openclaw"),
      },
    },
    channels: { whatsapp: { allowFrom: ["*"] } },
    session: { store: path.join(home, "sessions.json") },
  } as unknown as OpenClawConfig;
}

describe("getReplyFromConfig media note plumbing", () => {
  beforeEach(async () => {
    vi.resetModules();
    agentMocks.runEmbeddedPiAgent.mockClear();
    agentMocks.loadModelCatalog.mockClear();
    agentMocks.loadModelCatalog.mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
    ]);
    ({ getReplyFromConfig } = await import("./reply.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("includes all MediaPaths in the agent prompt", async () => {
    await withTempHome(async (home) => {
      let seenPrompt: string | undefined;
      agentMocks.runEmbeddedPiAgent.mockImplementation(async (params) => {
        seenPrompt = params.prompt;
        return makeResult("ok");
      });

      const cfg = makeCfg(home);
      const res = await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1001",
          To: "+2000",
          MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
          MediaUrls: ["/tmp/a.png", "/tmp/b.png"],
        },
        {},
        cfg,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(seenPrompt).toBeTruthy();
      expect(seenPrompt).toContain("[media attached: 2 files]");
      const idxA = seenPrompt?.indexOf("[media attached 1/2: /tmp/a.png");
      const idxB = seenPrompt?.indexOf("[media attached 2/2: /tmp/b.png");
      expect(typeof idxA).toBe("number");
      expect(typeof idxB).toBe("number");
      expect((idxA ?? -1) >= 0).toBe(true);
      expect((idxB ?? -1) >= 0).toBe(true);
      expect((idxA ?? 0) < (idxB ?? 0)).toBe(true);
    });
  });
});
