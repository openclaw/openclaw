import "./reply.directive.directive-behavior.e2e-mocks.js";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  runEmbeddedPiAgent,
  withTempHome,
} from "./reply.directive.directive-behavior.e2e-harness.js";
import { getReplyFromConfig } from "./reply.js";

describe("reply elevated defaults", () => {
  beforeEach(() => {
    vi.mocked(runEmbeddedPiAgent).mockReset();
  });

  it("defaults elevated mode to off when tools.elevated.enabled is true and elevatedDefault is unset", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1004",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1004",
        },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "openclaw"),
            },
          },
          tools: {
            elevated: {
              enabled: true,
              allowFrom: { whatsapp: ["+1004"] },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.bashElevated).toEqual({
        enabled: true,
        allowed: true,
        defaultLevel: "off",
      });
    });
  });

  it("respects explicit agents.defaults.elevatedDefault=on", async () => {
    await withTempHome(async (home) => {
      const storePath = path.join(home, "sessions.json");
      vi.mocked(runEmbeddedPiAgent).mockResolvedValue({
        payloads: [{ text: "done" }],
        meta: {
          durationMs: 5,
          agentMeta: { sessionId: "s", provider: "p", model: "m" },
        },
      });

      await getReplyFromConfig(
        {
          Body: "hello",
          From: "+1004",
          To: "+2000",
          Provider: "whatsapp",
          SenderE164: "+1004",
        },
        {},
        {
          agents: {
            defaults: {
              model: { primary: "anthropic/claude-opus-4-5" },
              workspace: path.join(home, "openclaw"),
              elevatedDefault: "on",
            },
          },
          tools: {
            elevated: {
              enabled: true,
              allowFrom: { whatsapp: ["+1004"] },
            },
          },
          channels: { whatsapp: { allowFrom: ["*"] } },
          session: { store: storePath },
        },
      );

      expect(runEmbeddedPiAgent).toHaveBeenCalledOnce();
      const call = vi.mocked(runEmbeddedPiAgent).mock.calls[0]?.[0];
      expect(call?.bashElevated).toEqual({
        enabled: true,
        allowed: true,
        defaultLevel: "on",
      });
    });
  });
});
