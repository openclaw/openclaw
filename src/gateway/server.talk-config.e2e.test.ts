import { describe, expect, it } from "vitest";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";
import { withServer } from "./test-with-server.js";

installGatewayTestHooks({ scope: "suite" });

describe("gateway talk.config", () => {
  it("returns redacted talk config for read scope", async () => {
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
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string; voiceId?: string } } }>(
        ws,
        "talk.config",
        {},
      );
      expect(res.ok).toBe(true);
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
        scopes: ["operator.read", "operator.write", "operator.talk.secrets"],
      });
      const res = await rpcReq<{ config?: { talk?: { apiKey?: string } } }>(ws, "talk.config", {
        includeSecrets: true,
      });
      expect(res.ok).toBe(true);
      expect(res.payload?.config?.talk?.apiKey).toBe("secret-key-abc");
    });
  });
});
