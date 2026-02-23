import "./isolated-agent.mocks.js";
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadModelCatalog } from "../agents/model-catalog.js";
import { runEmbeddedPiAgent } from "../agents/pi-embedded.js";
import type { CliDeps } from "../cli/deps.js";
import { runCronIsolatedAgentTurn } from "./isolated-agent.js";
import {
  makeCfg,
  makeJob,
  withTempCronHome,
  writeSessionStore,
  writeSessionStoreEntries,
} from "./isolated-agent.test-harness.js";
import type { CronJob } from "./types.js";
const withTempHome = withTempCronHome;

function makeDeps(): CliDeps {
  return {
    sendMessageSlack: vi.fn(),
    sendMessageWhatsApp: vi.fn(),
    sendMessageTelegram: vi.fn(),
    sendMessageDiscord: vi.fn(),
    sendMessageSignal: vi.fn(),
    sendMessageIMessage: vi.fn(),
  };
}

function mockEmbeddedTexts(texts: string[]) {
  vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
    payloads: texts.map((text) => ({ text })),
    meta: {
      durationMs: 5,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
}

function mockEmbeddedOk() {
  mockEmbeddedTexts(["ok"]);
}

function expectEmbeddedProviderModel(expected: { provider: string; model: string }) {
  const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as {
    provider?: string;
    model?: string;
  };
  expect(call?.provider).toBe(expected.provider);
  expect(call?.model).toBe(expected.model);
}

async function readSessionEntry(storePath: string, key: string) {
  const raw = await fs.readFile(storePath, "utf-8");
  const store = JSON.parse(raw) as Record<string, { sessionId?: string; label?: string }>;
  return store[key];
}

const DEFAULT_MESSAGE = "do it";
const DEFAULT_SESSION_KEY = "cron:job-1";
const DEFAULT_AGENT_TURN_PAYLOAD: CronJob["payload"] = {
  kind: "agentTurn",
  message: DEFAULT_MESSAGE,
  deliver: false,
};
const GMAIL_MODEL = "openrouter/meta-llama/llama-3.3-70b:free";

type RunCronTurnOptions = {
  cfgOverrides?: Parameters<typeof makeCfg>[2];
  deps?: CliDeps;
  jobPayload?: CronJob["payload"];
  message?: string;
  mockTexts?: string[] | null;
  sessionKey?: string;
  storeEntries?: Record<string, Record<string, unknown>>;
  storePath?: string;
};

async function runCronTurn(home: string, options: RunCronTurnOptions = {}) {
  const storePath =
    options.storePath ??
    (await writeSessionStoreEntries(home, {
      "agent:main:main": {
        sessionId: "main-session",
        updatedAt: Date.now(),
        lastProvider: "webchat",
        lastTo: "",
      },
      ...options.storeEntries,
    }));
  const deps = options.deps ?? makeDeps();
  if (options.mockTexts === null) {
    vi.mocked(runEmbeddedPiAgent).mockClear();
  } else {
    mockEmbeddedTexts(options.mockTexts ?? ["ok"]);
  }

  const jobPayload = options.jobPayload ?? DEFAULT_AGENT_TURN_PAYLOAD;
  const res = await runCronIsolatedAgentTurn({
    cfg: makeCfg(home, storePath, options.cfgOverrides),
    deps,
    job: makeJob(jobPayload),
    message:
      options.message ?? (jobPayload.kind === "agentTurn" ? jobPayload.message : DEFAULT_MESSAGE),
    sessionKey: options.sessionKey ?? DEFAULT_SESSION_KEY,
    lane: "cron",
  });

  return { deps, res, storePath };
}

async function runGmailHookTurn(
  home: string,
  storeEntries?: Record<string, Record<string, unknown>>,
) {
  return runCronTurn(home, {
    cfgOverrides: {
      hooks: {
        gmail: {
          model: GMAIL_MODEL,
        },
      },
    },
    jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
    sessionKey: "hook:gmail:msg-1",
    storeEntries,
  });
}

async function runTurnWithStoredModelOverride(
  home: string,
  jobPayload: CronJob["payload"],
  modelOverride = "gpt-4.1-mini",
) {
  return runCronTurn(home, {
    jobPayload,
    storeEntries: {
      "agent:main:cron:job-1": {
        sessionId: "existing-cron-session",
        updatedAt: Date.now(),
        providerOverride: "openai",
        modelOverride,
      },
    },
  });
}

describe("runCronIsolatedAgentTurn", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockClear();
    vi.mocked(loadModelCatalog).mockResolvedValue([]);
  });

  it("treats blank model overrides as unset", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: DEFAULT_MESSAGE, model: "   " },
      });

      expect(res.status).toBe("ok");
      expect(vi.mocked(runEmbeddedPiAgent)).toHaveBeenCalledTimes(1);
    });
  });

  it("uses last non-empty agent text as summary", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: ["first", " ", " last "],
      });

      expect(res.status).toBe("ok");
      expect(res.summary).toBe("last");
    });
  });

  it("passes resolved agentDir to runEmbeddedPiAgent", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        agentDir?: string;
      };
      expect(call?.agentDir).toBe(path.join(home, ".openclaw", "agents", "main", "agent"));
    });
  });

  it("appends current time after the cron header line", async () => {
    await withTempHome(async (home) => {
      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
      });

      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        prompt?: string;
      };
      const lines = call?.prompt?.split("\n") ?? [];
      expect(lines[0]).toContain("[cron:job-1");
      expect(lines[0]).toContain("do it");
      expect(lines[1]).toMatch(/^Current time: .+ \(.+\)$/);
    });
  });

  it("uses agentId for workspace, session key, and store paths", async () => {
    await withTempHome(async (home) => {
      const deps = makeDeps();
      const opsWorkspace = path.join(home, "ops-workspace");
      mockEmbeddedOk();

      const cfg = makeCfg(
        home,
        path.join(home, ".openclaw", "agents", "{agentId}", "sessions", "sessions.json"),
        {
          agents: {
            defaults: { workspace: path.join(home, "default-workspace") },
            list: [
              { id: "main", default: true },
              { id: "ops", workspace: opsWorkspace },
            ],
          },
        },
      );

      const res = await runCronIsolatedAgentTurn({
        cfg,
        deps,
        job: {
          ...makeJob({
            kind: "agentTurn",
            message: DEFAULT_MESSAGE,
            deliver: false,
            channel: "last",
          }),
          agentId: "ops",
        },
        message: DEFAULT_MESSAGE,
        sessionKey: "cron:job-ops",
        agentId: "ops",
        lane: "cron",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0] as {
        sessionKey?: string;
        workspaceDir?: string;
        sessionFile?: string;
      };
      expect(call?.sessionKey).toBe("agent:ops:cron:job-ops");
      expect(call?.workspaceDir).toBe(opsWorkspace);
      expect(call?.sessionFile).toContain(path.join("agents", "ops"));
    });
  });

  it("uses model override when provided", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "openai/gpt-4.1-mini",
        },
      });

      expect(res.status).toBe("ok");
      expectEmbeddedProviderModel({ provider: "openai", model: "gpt-4.1-mini" });
    });
  });

  it("uses stored session override when no job model override is provided", async () => {
    await withTempHome(async (home) => {
      const { res } = await runTurnWithStoredModelOverride(home, {
        kind: "agentTurn",
        message: DEFAULT_MESSAGE,
        deliver: false,
      });

      expect(res.status).toBe("ok");
      expectEmbeddedProviderModel({ provider: "openai", model: "gpt-4.1-mini" });
    });
  });

  it("prefers job model override over stored session override", async () => {
    await withTempHome(async (home) => {
      const { res } = await runTurnWithStoredModelOverride(home, {
        kind: "agentTurn",
        message: DEFAULT_MESSAGE,
        model: "anthropic/claude-opus-4-5",
        deliver: false,
      });

      expect(res.status).toBe("ok");
      expectEmbeddedProviderModel({ provider: "anthropic", model: "claude-opus-4-5" });
    });
  });

  it("uses hooks.gmail.model for Gmail hook sessions", async () => {
    await withTempHome(async (home) => {
      const { res } = await runGmailHookTurn(home);

      expect(res.status).toBe("ok");
      expectEmbeddedProviderModel({
        provider: "openrouter",
        model: GMAIL_MODEL.replace("openrouter/", ""),
      });
    });
  });

  it("keeps hooks.gmail.model precedence over stored session override", async () => {
    await withTempHome(async (home) => {
      const { res } = await runGmailHookTurn(home, {
        "agent:main:hook:gmail:msg-1": {
          sessionId: "existing-gmail-session",
          updatedAt: Date.now(),
          providerOverride: "anthropic",
          modelOverride: "claude-opus-4-5",
        },
      });

      expect(res.status).toBe("ok");
      expectEmbeddedProviderModel({
        provider: "openrouter",
        model: GMAIL_MODEL.replace("openrouter/", ""),
      });
    });
  });

  it("wraps external hook content by default", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: "Hello" },
        message: "Hello",
        sessionKey: "hook:gmail:msg-1",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as { prompt?: string };
      expect(call?.prompt).toContain("EXTERNAL, UNTRUSTED");
      expect(call?.prompt).toContain("Hello");
    });
  });

  it("skips external content wrapping when hooks.gmail opts out", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        cfgOverrides: {
          hooks: {
            gmail: {
              allowUnsafeExternalContent: true,
            },
          },
        },
        jobPayload: { kind: "agentTurn", message: "Hello" },
        message: "Hello",
        sessionKey: "hook:gmail:msg-2",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as { prompt?: string };
      expect(call?.prompt).not.toContain("EXTERNAL, UNTRUSTED");
      expect(call?.prompt).toContain("Hello");
    });
  });

  it("ignores hooks.gmail.model when not in the allowlist", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
        },
      ]);

      const { res } = await runCronTurn(home, {
        cfgOverrides: {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              models: {
                "anthropic/claude-opus-4-5": { alias: "Opus" },
              },
            },
          },
          hooks: {
            gmail: {
              model: "openrouter/meta-llama/llama-3.3-70b:free",
            },
          },
        },
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        sessionKey: "hook:gmail:msg-2",
      });

      expect(res.status).toBe("ok");
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0] as {
        provider?: string;
        model?: string;
      };
      expect(call?.provider).toBe("anthropic");
      expect(call?.model).toBe("claude-opus-4-5");
    });
  });

  it("rejects invalid model override", async () => {
    await withTempHome(async (home) => {
      const { res } = await runCronTurn(home, {
        jobPayload: {
          kind: "agentTurn",
          message: DEFAULT_MESSAGE,
          model: "openai/",
        },
        mockTexts: null,
      });

      expect(res.status).toBe("error");
      expect(res.error).toMatch("invalid model");
      expect(vi.mocked(runEmbeddedPiAgent)).not.toHaveBeenCalled();
    });
  });

  it("defaults thinking to low for reasoning-capable models", async () => {
    await withTempHome(async (home) => {
      vi.mocked(loadModelCatalog).mockResolvedValueOnce([
        {
          id: "claude-opus-4-5",
          name: "Opus 4.5",
          provider: "anthropic",
          reasoning: true,
        },
      ]);

      await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: ["done"],
      });

      const callArgs = vi.mocked(runEmbeddedPiAgent).mock.calls.at(-1)?.[0];
      expect(callArgs?.thinkLevel).toBe("low");
    });
  });

  it("truncates long summaries", async () => {
    await withTempHome(async (home) => {
      const long = "a".repeat(2001);
      const { res } = await runCronTurn(home, {
        jobPayload: DEFAULT_AGENT_TURN_PAYLOAD,
        mockTexts: [long],
      });

      expect(res.status).toBe("ok");
      expect(String(res.summary ?? "")).toMatch(/…$/);
    });
  });

  it("starts a fresh session id for each cron run", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const deps = makeDeps();

      const first = (
        await runCronTurn(home, {
          deps,
          jobPayload: { kind: "agentTurn", message: "ping", deliver: false },
          message: "ping",
          mockTexts: ["ok"],
          storePath,
        })
      ).res;

      const second = (
        await runCronTurn(home, {
          deps,
          jobPayload: { kind: "agentTurn", message: "ping", deliver: false },
          message: "ping",
          mockTexts: ["ok"],
          storePath,
        })
      ).res;

      expect(first.sessionId).toBeDefined();
      expect(second.sessionId).toBeDefined();
      expect(second.sessionId).not.toBe(first.sessionId);
      expect(first.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).toMatch(/^agent:main:cron:job-1:run:/);
      expect(second.sessionKey).not.toBe(first.sessionKey);
    });
  });

  it("preserves an existing cron session label", async () => {
    await withTempHome(async (home) => {
      const storePath = await writeSessionStore(home, { lastProvider: "webchat", lastTo: "" });
      const raw = await fs.readFile(storePath, "utf-8");
      const store = JSON.parse(raw) as Record<string, Record<string, unknown>>;
      store["agent:main:cron:job-1"] = {
        sessionId: "old",
        updatedAt: Date.now(),
        label: "Nightly digest",
      };
      await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");

      await runCronTurn(home, {
        jobPayload: { kind: "agentTurn", message: "ping", deliver: false },
        message: "ping",
        storePath,
      });
      const entry = await readSessionEntry(storePath, "agent:main:cron:job-1");

      expect(entry?.label).toBe("Nightly digest");
    });
  });
});
