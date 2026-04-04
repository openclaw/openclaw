import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  createReplyRuntimeMocks,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  resetReplyRuntimeMocks,
} from "./reply.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();

installReplyRuntimeMocks(agentMocks);

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
        model: "anthropic/claude-opus-4-6",
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
    resetReplyRuntimeMocks(agentMocks);
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
        return makeEmbeddedTextResult("ok");
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
