import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();
const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-getreply-fast-" });

installReplyRuntimeMocks(agentMocks);

describe("getReplyFromConfig fast-path runtime", () => {
  beforeEach(async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "1");
    resetReplyRuntimeMocks(agentMocks);
    ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("keeps old-style runtime tests fast with marked temp-home configs", async () => {
    await withTempHome(async (home) => {
      let seenPrompt: string | undefined;
      agentMocks.runEmbeddedPiAgent.mockImplementation(async (params) => {
        seenPrompt = params.prompt;
        return makeEmbeddedTextResult("ok");
      });

      const res = await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "+1001",
          To: "+2000",
          MediaPaths: ["/tmp/a.png", "/tmp/b.png"],
          MediaUrls: ["/tmp/a.png", "/tmp/b.png"],
          SessionKey: "agent:main:whatsapp:+2000",
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("ok");
      expect(seenPrompt).toContain("[media attached: 2 files]");
      expect(seenPrompt).toContain("hello");
    });
  });

  it("preserves session fast mode in the fast-path runtime", async () => {
    await withTempHome(async (home) => {
      const sessionKey = "agent:main:whatsapp:+2000";
      const sessionFile = path.join(
        home,
        ".openclaw",
        "agents",
        "main",
        "sessions",
        "session-fast-mode.jsonl",
      );
      await fs.writeFile(
        path.join(home, "sessions.json"),
        JSON.stringify({
          [sessionKey]: {
            sessionId: "session-fast-mode",
            sessionFile,
            fastMode: true,
            updatedAt: Date.now(),
          },
        }),
        "utf8",
      );

      let seenFastMode: unknown;
      agentMocks.runEmbeddedPiAgent.mockImplementation(async (params) => {
        seenFastMode = params.fastMode;
        return makeEmbeddedTextResult("ok");
      });

      await getReplyFromConfig(
        {
          Body: "hello",
          BodyForAgent: "hello",
          RawBody: "hello",
          CommandBody: "hello",
          From: "+1001",
          To: "+2000",
          SessionKey: sessionKey,
          Provider: "whatsapp",
          Surface: "whatsapp",
          ChatType: "direct",
        },
        {},
        makeReplyConfig(home) as OpenClawConfig,
      );

      expect(seenFastMode).toBe(true);
    });
  });
});
