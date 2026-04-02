import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "./reply.test-harness.js";
let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();

const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-rawbody-" });

installReplyRuntimeMocks(agentMocks);

describe("RawBody directive parsing", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
    ({ getReplyFromConfig } = await import("./reply.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("handles directives and history in the prompt", async () => {
    await withTempHome(async (home) => {
      agentMocks.runEmbeddedPiAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));

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
