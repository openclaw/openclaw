import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createTempHomeHarness, makeReplyConfig } from "./reply.test-harness.js";

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

const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-rawbody-" });

describe("RawBody directive parsing", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
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

  it("handles directives and history in the prompt", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedPiAgent.mockResolvedValue({
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
        makeReplyConfig(home) as OpenClawConfig,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(agentMocks.runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const prompt =
        (agentMocks.runEmbeddedPiAgent.mock.calls[0]?.[0] as { prompt?: string } | undefined)
          ?.prompt ?? "";
      expect(prompt).toContain("Chat history since last reply (untrusted, for context):");
      expect(prompt).toContain('"sender": "Peter"');
      expect(prompt).toContain('"body": "hello"');
      expect(prompt).toContain("status please");
      expect(prompt).not.toContain("/think:high");
    });
  });
});
