import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway talk.config", () => {
  it("returns secrets for operator.talk.secrets scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        apiKey: "secret-key-abc",
      },
    });

    await withServer(async (ws) => {
      await connectOk(ws, {
        token: "secret",
      });
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string } } }>(ws, "talk.config", {
        includeSecrets: true,
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.apiKey).toBe("secret-key-abc");
    });
  });

  it("returns normalized talk config plus redacted legacy fields for read scope", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        voiceId: "voice-123",
        apiKey: "secret-key-abc",
      },
      session: {
        mainKey: "main-test",
      },
      ui: {
        seamColor: "#112233",
      },
    });

    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq<{
        config?: {
          talk?: {
            provider?: string;
            providers?: {
              elevenlabs?: { voiceId?: string; apiKey?: string };
            };
            apiKey?: string;
            voiceId?: string;
          };
        };
      }>(ws, "talk.config", {});
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.provider).toBe("elevenlabs");
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.voiceId).toBe("voice-123");
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.apiKey).toBe(
        "__OPENCLAW_REDACTED__",
      );
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-123");
      expect(res.payload?.config?.talk?.apiKey).toBe("__OPENCLAW_REDACTED__");
    });
  });

  it("requires operator.talk.secrets for includeSecrets", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        apiKey: "secret-key-abc",
      },
    });

    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq(ws, "talk.config", { includeSecrets: true });
      expect(res.ok).toBe(false);
      expect(res.error?.message).toContain("missing scope: operator.talk.secrets");
    });
  });

  it("prefers normalized provider payload over conflicting legacy talk keys", async () => {
    const { writeConfigFile } = await import("../config/config.js");
    await writeConfigFile({
      talk: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            voiceId: "voice-normalized",
          },
        },
        voiceId: "voice-legacy",
      },
    });

    await withServer(async (ws) => {
      await connectOk(ws, { token: "secret", scopes: ["operator.read"] });
      const res = await rpcReq<{
        config?: {
          talk?: {
            provider?: string;
            providers?: {
              elevenlabs?: { voiceId?: string };
            };
            voiceId?: string;
          };
        };
      }>(ws, "talk.config", {});
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.provider).toBe("elevenlabs");
      expect(res.payload?.config?.talk?.providers?.elevenlabs?.voiceId).toBe("voice-normalized");
      expect(res.payload?.config?.talk?.voiceId).toBe("voice-normalized");
    });
  });
});
