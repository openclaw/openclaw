import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import { saveSessionStore } from "../config/sessions.js";
import { getReplyFromConfig } from "./reply.js";

vi.mock("../agents/pi-embedded.js", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessage: vi.fn().mockReturnValue(false),
  resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog: vi.fn(),
}));

type HomeEnvSnapshot = {
  HOME: string | undefined;
  USERPROFILE: string | undefined;
  HOMEDRIVE: string | undefined;
  HOMEPATH: string | undefined;
  OPENCLAW_STATE_DIR: string | undefined;
  OPENCLAW_AGENT_DIR: string | undefined;
  PI_CODING_AGENT_DIR: string | undefined;
};

function snapshotHomeEnv(): HomeEnvSnapshot {
  return {
    HOME: process.env.HOME,
    USERPROFILE: process.env.USERPROFILE,
    HOMEDRIVE: process.env.HOMEDRIVE,
    HOMEPATH: process.env.HOMEPATH,
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    OPENCLAW_AGENT_DIR: process.env.OPENCLAW_AGENT_DIR,
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

let fixtureRoot = "";
let caseId = 0;

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = path.join(fixtureRoot, `case-${++caseId}`);
  await fs.mkdir(path.join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  const envSnapshot = snapshotHomeEnv();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.OPENCLAW_STATE_DIR = path.join(home, ".openclaw");
  process.env.OPENCLAW_AGENT_DIR = path.join(home, ".openclaw", "agent");
  process.env.PI_CODING_AGENT_DIR = path.join(home, ".openclaw", "agent");

  if (process.platform === "win32") {
    const match = home.match(/^([A-Za-z]:)(.*)$/);
    if (match) {
      process.env.HOMEDRIVE = match[1];
      process.env.HOMEPATH = match[2] || "\\";
    }
  }

  try {
    return await fn(home);
  } finally {
    restoreHomeEnv(envSnapshot);
  }
}

describe("RawBody directive parsing", () => {
  type ReplyMessage = Parameters<typeof getReplyFromConfig>[0];
  type ReplyConfig = Parameters<typeof getReplyFromConfig>[2];

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-rawbody-"));
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
    vi.mocked(loadModelCatalog).mockResolvedValue([
      { id: "claude-opus-4-5", name: "Opus 4.5", provider: "anthropic" },
    ]);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("detects command directives from RawBody/CommandBody in wrapped group messages", async () => {
    await withTempHome(async (home) => {
      const assertCommandReply = async (input: {
        message: ReplyMessage;
        config: ReplyConfig;
        expectedIncludes: string[];
      }) => {
        vi.mocked(runEmbeddedPiAgent).mockReset();
        const res = await getReplyFromConfig(input.message, {}, input.config);
        const text = Array.isArray(res) ? res[0]?.text : res?.text;
        for (const expected of input.expectedIncludes) {
          expect(text).toContain(expected);
        }
        expect(runEmbeddedPiAgent).not.toHaveBeenCalled();
      };

      await assertCommandReply({
        message: {
          Body: `[Chat messages since your last reply - for context]\\n[WhatsApp ...] Someone: hello\\n\\n[Current message - respond to this]\\n[WhatsApp ...] Jake: /think:high\\n[from: Jake McInteer (+6421807830)]`,
          RawBody: "/think:high",
          From: "+1222",
          To: "+1222",
          ChatType: "group",
          CommandAuthorized: true,
        },
        config: {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw-1"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions-1.json") },
        },
        expectedIncludes: ["Thinking level set to high."],
      });

      await assertCommandReply({
        message: {
          Body: "[Context]\nJake: /verbose on\n[from: Jake]",
          CommandBody: "/verbose on",
          From: "+1222",
          To: "+1222",
          ChatType: "group",
          CommandAuthorized: true,
        },
        config: {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw-2"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions-2.json") },
        },
        expectedIncludes: ["Verbose logging enabled."],
      });
    });
  });

  it("preserves history and reuses non-default agent session files", async () => {
    await withTempHome(async (home) => {
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const groupMessageCtx = {
        Body: "/think:high status please",
        BodyForAgent: "/think:high status please",
        RawBody: "/think:high status please",
        InboundHistory: [{ sender: "Peter", body: "hello", timestamp: 1700000000000 }],
        From: "+1222",
        To: "+1222",
        ChatType: "group",
        GroupSubject: "Ops",
        SenderName: "Jake McInteer",
        SenderE164: "+6421807830",
        CommandAuthorized: true,
      };

      const res = await getReplyFromConfig(
        groupMessageCtx,
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: path.join(home, "sessions.json") },
        },
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("Chat history since last reply (untrusted, for context):");
      expect(prompt).toContain('"sender": "Peter"');
      expect(prompt).toContain('"body": "hello"');
      expect(prompt).toContain("status please");
      expect(prompt).not.toContain("/think:high");
      const agentId = "worker1";
      const sessionId = "sess-worker-1";
      const sessionKey = `agent:${agentId}:telegram:12345`;
      const sessionsDir = path.join(home, ".openclaw", "agents", agentId, "sessions");
      const sessionFile = path.join(sessionsDir, `${sessionId}.jsonl`);
      const storePath = path.join(sessionsDir, "sessions.json");
      await fs.mkdir(sessionsDir, { recursive: true });
      await fs.writeFile(sessionFile, "", "utf-8");
      await saveSessionStore(storePath, {
        [sessionKey]: {
          sessionId,
          sessionFile,
          updatedAt: Date.now(),
        },
      });

      vi.mocked(runEmbeddedPiAgent).mockReset();
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "ok" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId, provider: "anthropic", model: "claude-opus-4-5" },
        },
      });

      const resWorker = await getReplyFromConfig(
        {
          Body: "hello",
          From: "telegram:12345",
          To: "telegram:12345",
          SessionKey: sessionKey,
          Provider: "telegram",
          Surface: "telegram",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: path.join(home, "openclaw"),
            },
          },
        },
      );

      const textWorker = Array.isArray(resWorker) ? resWorker[0]?.text : resWorker?.text;
      expect(textWorker).toBe("ok");
      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      expect(vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0]?.sessionFile).toBe(sessionFile);
    });
  });
});
