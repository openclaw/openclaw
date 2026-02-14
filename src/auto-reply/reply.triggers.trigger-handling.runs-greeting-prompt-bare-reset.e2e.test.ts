import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  getRunEmbeddedPiAgentMock,
  installTriggerHandlingE2eTestHooks,
  withTempHome,
} from "./reply.triggers.trigger-handling.test-harness.js";

let getReplyFromConfig: typeof import("./reply.js").getReplyFromConfig;
beforeAll(async () => {
  ({ getReplyFromConfig } = await import("./reply.js"));
});

installTriggerHandlingE2eTestHooks();

describe("trigger handling", () => {
  it("runs a greeting prompt for a bare /reset", async () => {
    await withTempHome(async (home) => {
      getRunEmbeddedPiAgentMock().mockResolvedValue({
        payloads: [{ text: "hello" }],
        meta: {
          durationMs: 1,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "openclaw"),
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["*"],
            },
          },
          session: {
            store: join(tmpdir(), `openclaw-session-test-${Date.now()}.json`),
          },
        },
      );
      const text = Array.isArray(res) ? res[0]?.text : res?.text;
      expect(text).toBe("hello");
      expect(getRunEmbeddedPiAgentMock()).toHaveBeenCalledOnce();
      const prompt = getRunEmbeddedPiAgentMock().mock.calls[0]?.[0]?.prompt ?? "";
      expect(prompt).toContain("A new session was started via /new or /reset");
    });
  });
  it("does not reset for unauthorized /reset", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: false,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "openclaw"),
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["+1999"],
            },
          },
          session: {
            store: join(tmpdir(), `openclaw-session-test-${Date.now()}.json`),
          },
        },
      );
      expect(res).toBeUndefined();
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });
  it("blocks /reset for non-owner senders", async () => {
    await withTempHome(async (home) => {
      const res = await getReplyFromConfig(
        {
          Body: "/reset",
          From: "+1003",
          To: "+2000",
          CommandAuthorized: true,
        },
        {},
        {
          agents: {
            defaults: {
              model: "anthropic/claude-opus-4-5",
              workspace: join(home, "openclaw"),
            },
          },
          channels: {
            whatsapp: {
              allowFrom: ["+1999"],
            },
          },
          session: {
            store: join(tmpdir(), `openclaw-session-test-${Date.now()}.json`),
          },
        },
      );
      expect(res).toBeUndefined();
      expect(getRunEmbeddedPiAgentMock()).not.toHaveBeenCalled();
    });
  });
});
