import { createHmac } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";

const envSnapshot = captureEnv(["HOME", "OPENCLAW_HOME", "OPENCLAW_STATE_DIR"]);

const tempHomes: string[] = [];

function useTempHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-agent-runtime-"));
  tempHomes.push(home);
  setTestEnvValue("HOME", home);
  setTestEnvValue("OPENCLAW_HOME", home);
  setTestEnvValue("OPENCLAW_STATE_DIR", "");
  return home;
}

function execApprovalsPath(home: string): string {
  return path.join(home, ".openclaw", "exec-approvals.json");
}

function readExecApprovals(home: string): {
  socket?: { token?: string };
} {
  return JSON.parse(fs.readFileSync(execApprovalsPath(home), "utf8")) as {
    socket?: { token?: string };
  };
}

function signAgentRuntimePayload(home: string, payload: unknown): string {
  const signingMaterial = readExecApprovals(home).socket?.token;
  if (!signingMaterial) {
    throw new Error("missing test signing secret");
  }
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", signingMaterial)
    .update(["openclaw", "gateway-agent-runtime-identity-token", "v1"].join(":"))
    .update("\0")
    .update(encodedPayload)
    .digest("base64url");
  return `${encodedPayload}.${signature}`;
}

async function importRuntimeTokenModule(): Promise<
  typeof import("./agent-runtime-identity-token.js")
> {
  vi.resetModules();
  return await import("./agent-runtime-identity-token.js");
}

afterEach(() => {
  vi.resetModules();
  envSnapshot.restore();
  for (const home of tempHomes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

describe("agent runtime identity token", () => {
  it("persists the local signing secret so tokens verify across processes", async () => {
    const home = useTempHome();
    const firstProcess = await importRuntimeTokenModule();

    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["wake"],
    });

    const persistedToken = readExecApprovals(home).socket?.token;
    expect(persistedToken).toEqual(expect.any(String));
    expect(persistedToken).not.toHaveLength(0);

    const secondProcess = await importRuntimeTokenModule();
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toEqual({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["wake"],
    });
  });

  it("does not mint local credentials while rejecting invalid presented tokens", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken("not-a-valid-token"),
    ).resolves.toBeUndefined();
    expect(fs.existsSync(execApprovalsPath(home))).toBe(false);
  });

  it("rejects a token with a shortened signature", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["wake"],
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token.slice(0, -1)),
    ).resolves.toBeUndefined();
  });

  it("rejects tokens minted from a different local state directory", async () => {
    const firstHome = useTempHome();
    const firstProcess = await importRuntimeTokenModule();
    const token = await firstProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["wake"],
    });
    expect(fs.existsSync(execApprovalsPath(firstHome))).toBe(true);

    useTempHome();
    const secondProcess = await importRuntimeTokenModule();
    const secondToken = await secondProcess.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["wake"],
    });

    expect(secondToken).not.toBe(token);
    await expect(secondProcess.verifyAgentRuntimeIdentityToken(token)).resolves.toBeUndefined();
  });

  it("requires one gateway method matching the token delegation shape", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "source",
      sessionKey: "agent:source:main",
    });
    const request = {
      message: "inspect",
      sessionKey: "agent:target:main",
      idempotencyKey: "method-matrix",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    };

    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["config.get"],
      }),
    ).resolves.toEqual(expect.any(String));
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["config.get", "config.apply"],
      }),
    ).rejects.toThrow("methods matching its delegation");
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["agent"],
        messageActionContext: { expiresAtMs: Date.now() + 10_000, turnAuthority },
      }),
    ).rejects.toThrow("methods matching its delegation");
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["wake"],
        sessionsSendDelegation: {
          targetAgentId: "target",
          targetSessionKey: "agent:target:main",
          request,
          turnAuthority,
        },
      }),
    ).rejects.toThrow("methods matching its delegation");
  });

  it("rejects signed payloads with a widened gateway method grant", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      gatewayMethods: ["wake"],
    });
    const [encodedPayload] = token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as {
      gatewayMethods: string[];
    };
    payload.gatewayMethods = ["wake", "config.get"];

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(signAgentRuntimePayload(home, payload)),
    ).resolves.toBeUndefined();
  });

  it("round-trips signed message action context and rejects it after expiry", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        senderId: "maintainer-1",
        aliases: {
          name: "maintainer one",
          username: "maintainer-1",
          e164: "+15550001111",
        },
        senderIsOwner: false,
      },
      agentId: "main",
      sessionKey: "session-1",
    });
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["message.action"],
      messageActionContext: {
        expiresAtMs: 5000,
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        sessionId: "session-id-1",
        requesterAccountId: "ops",
        requesterSenderId: "sender-1",
        requesterSenderIsOwner: false,
        requesterIsAuthorizedSender: true,
        requesterRoleIds: ["maintainers", "contributors", "maintainers"],
        parentConversationId: "!parent:example.org",
        turnAuthority,
        toolContext: {
          currentChannelProvider: "matrix",
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
          currentSourceTurnId: "channel-user:v1:source-1",
        },
      },
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token, 4000)).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["message.action"],
      messageActionContext: {
        expiresAtMs: 5000,
        sourceReplyFinal: true,
        sourceReplyToolCallId: "message-call-1",
        sessionId: "session-id-1",
        requesterAccountId: "ops",
        requesterSenderId: "sender-1",
        requesterSenderIsOwner: false,
        requesterIsAuthorizedSender: true,
        requesterRoleIds: ["contributors", "maintainers"],
        parentConversationId: "!parent:example.org",
        turnAuthority: {
          authorization: {
            principal: {
              kind: "sender",
              senderId: "maintainer-1",
              aliases: {
                name: "maintainer one",
                username: "maintainer-1",
                e164: "+15550001111",
              },
              senderIsOwner: false,
            },
            agentId: "main",
            sessionKey: "session-1",
          },
        },
        toolContext: {
          currentChannelProvider: "matrix",
          currentChannelId: "!room:example.org",
          currentChatType: "direct",
          currentSourceTurnId: "channel-user:v1:source-1",
        },
      },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 5000),
    ).resolves.toBeUndefined();
  });

  it("rejects unissued or mismatched message action authority when minting", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "main",
      sessionKey: "session-1",
    });
    const mint = (params: {
      agentId: string;
      sessionKey: string;
      turnAuthority: typeof turnAuthority;
    }) =>
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        gatewayMethods: ["message.action"],
        messageActionContext: {
          expiresAtMs: 5000,
          turnAuthority: params.turnAuthority,
        },
      });

    await expect(
      mint({
        agentId: "main",
        sessionKey: "session-1",
        turnAuthority: structuredClone(turnAuthority),
      }),
    ).rejects.toThrow("host-issued turn authority matching runtime identity");
    await expect(
      mint({ agentId: "other", sessionKey: "session-1", turnAuthority }),
    ).rejects.toThrow("host-issued turn authority matching runtime identity");
    await expect(mint({ agentId: "main", sessionKey: "session-2", turnAuthority })).rejects.toThrow(
      "host-issued turn authority matching runtime identity",
    );
  });

  it("rejects signed message action authority mismatches while decoding", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "main",
      sessionKey: "session-1",
    });
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["message.action"],
      messageActionContext: { expiresAtMs: 5000, turnAuthority },
    });
    const [encodedPayload] = token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as {
      messageActionContext: {
        turnAuthority: { authorization: { agentId: string; sessionKey: string } };
      };
    };

    payload.messageActionContext.turnAuthority.authorization.agentId = "other";
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(signAgentRuntimePayload(home, payload), 4000),
    ).resolves.toBeUndefined();

    payload.messageActionContext.turnAuthority.authorization.agentId = "main";
    payload.messageActionContext.turnAuthority.authorization.sessionKey = "session-2";
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(signAgentRuntimePayload(home, payload), 4000),
    ).resolves.toBeUndefined();
  });

  it("bounds run-lifetime message action bearers independently of local revocation", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["message.action"],
      messageActionContext: { expiresAtMs: Number.MAX_SAFE_INTEGER },
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 60_999),
    ).resolves.toMatchObject({
      messageActionContext: { expiresAtMs: 61_000 },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 61_000),
    ).resolves.toBeUndefined();
    nowSpy.mockRestore();
  });

  it("mints scoped tokens from authority rebound from a caller alias", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot, rebindTurnAuthoritySnapshot } =
      await import("../plugins/turn-authority.js");
    const aliasedAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "ops",
      sessionKey: "main",
      trigger: "channel",
    });
    const turnAuthority = rebindTurnAuthoritySnapshot(aliasedAuthority, {
      agentId: "ops",
      sessionKey: "agent:ops:main",
      trigger: aliasedAuthority.authorization.trigger,
    });
    if (!turnAuthority) {
      throw new Error("expected rebound authority");
    }

    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "ops",
        sessionKey: "agent:ops:main",
        gatewayMethods: ["message.action"],
        messageActionContext: { expiresAtMs: Date.now() + 10_000, turnAuthority },
      }),
    ).resolves.toEqual(expect.any(String));

    const request = {
      message: "inspect startup",
      sessionKey: "agent:target:main",
      idempotencyKey: "alias-send",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    };
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "ops",
        sessionKey: "agent:ops:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "target",
          targetSessionKey: "agent:target:main",
          request,
          turnAuthority,
        },
      }),
    ).resolves.toEqual(expect.any(String));
  });

  it("binds sessions_send authority to one exact target and request with a short TTL", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1000);
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: {
        kind: "sender",
        provider: "discord",
        accountId: "molty",
        senderId: "maintainer-1",
        senderIsOwner: false,
        isAuthorizedSender: true,
        roleIds: ["maintainers"],
      },
      agentId: "source",
      sessionKey: "agent:source:main",
      conversationId: "maintenance",
      threadId: "thread-1",
      trigger: "channel",
      controllerKey: "sender:discord:molty:maintainer-1",
    });
    const request = {
      message: "[Inter-session message] inspect startup",
      sessionKey: "agent:target:main",
      idempotencyKey: "send-1",
      deliver: false,
      inputProvenance: {
        kind: "inter_session",
        sourceSessionKey: "agent:source:main",
        sourceTool: "sessions_send",
      },
    };
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "source",
      sessionKey: "agent:source:main",
      gatewayMethods: ["agent"],
      sessionsSendDelegation: {
        targetAgentId: "target",
        targetSessionKey: "agent:target:main",
        request,
        turnAuthority,
        transcriptMessage: "canonical user-visible transcript",
      },
    });

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 60_999),
    ).resolves.toMatchObject({
      kind: "agentRuntime",
      agentId: "source",
      sessionKey: "agent:source:main",
      gatewayMethods: ["agent"],
      sessionsSendDelegation: {
        kind: "sessions_send",
        expiresAtMs: 61_000,
        targetAgentId: "target",
        targetSessionKey: "agent:target:main",
        requestDigest: runtimeToken.digestSessionsSendAgentRequest(request),
        transcriptMessage: "canonical user-visible transcript",
        turnAuthority: {
          authorization: {
            principal: {
              kind: "sender",
              senderId: "maintainer-1",
              senderIsOwner: false,
              roleIds: ["maintainers"],
            },
            agentId: "source",
            sessionKey: "agent:source:main",
          },
        },
      },
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(token, 61_000),
    ).resolves.toBeUndefined();
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "target",
          targetSessionKey: "main",
          request: { ...request, sessionKey: "main" },
          turnAuthority,
        },
      }),
    ).rejects.toThrow("exact target");
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "target",
          targetSessionKey: "agent:target:main",
          request: { ...request, sessionKey: "agent:other:main" },
          turnAuthority,
        },
      }),
    ).rejects.toThrow("exact target");
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "target",
          targetSessionKey: "agent:target:main",
          request,
          turnAuthority,
          transcriptMessage: "",
        },
      }),
    ).rejects.toThrow("transcript message must be non-empty");
    expect(
      runtimeToken.digestSessionsSendAgentRequest({ ...request, message: "tampered" }),
    ).not.toBe(runtimeToken.digestSessionsSendAgentRequest(request));
    nowSpy.mockRestore();
  });

  it("rejects sessions_send token tampering and mismatched source authority", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer-1", senderIsOwner: false },
      agentId: "source",
      sessionKey: "agent:source:main",
    });
    const request = {
      message: "hello",
      sessionKey: "agent:target:main",
      idempotencyKey: "send-1",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    };
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "source",
      sessionKey: "agent:source:main",
      gatewayMethods: ["agent"],
      sessionsSendDelegation: {
        targetAgentId: "target",
        targetSessionKey: "agent:target:main",
        request,
        turnAuthority,
      },
    });
    const [encodedPayload, signature] = token.split(".");
    const payload = JSON.parse(Buffer.from(encodedPayload ?? "", "base64url").toString("utf8")) as {
      sessionsSendDelegation: { targetSessionKey: string };
    };
    payload.sessionsSendDelegation.targetSessionKey = "agent:other:main";
    const tamperedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(`${tamperedPayload}.${signature}`),
    ).resolves.toBeUndefined();
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "other",
        sessionKey: "agent:other:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "target",
          targetSessionKey: "agent:target:main",
          request,
          turnAuthority,
        },
      }),
    ).rejects.toThrow("matching issued turn authority");
  });

  it("binds global sessions_send delegation to the explicit adjacent agent id", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer", senderIsOwner: false },
      agentId: "work",
      sessionKey: "global",
    });
    const request = {
      message: "hello",
      sessionKey: "global",
      agentId: "work",
      idempotencyKey: "send-global",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    };
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "work",
      sessionKey: "global",
      gatewayMethods: ["agent"],
      sessionsSendDelegation: {
        targetAgentId: "work",
        targetSessionKey: "global",
        request,
        turnAuthority,
      },
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      agentId: "work",
      sessionKey: "global",
      sessionsSendDelegation: {
        targetAgentId: "work",
        targetSessionKey: "global",
      },
    });
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "work",
        sessionKey: "global",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "other",
          targetSessionKey: "global",
          request,
          turnAuthority,
        },
      }),
    ).rejects.toThrow("exact target");
  });

  it("round-trips custom unscoped sessions_send endpoints with exact adjacent agents", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer", senderIsOwner: false },
      agentId: "source",
      sessionKey: "custom-source-session",
    });
    const request = {
      message: "hello",
      sessionKey: "custom-ops-session",
      agentId: "ops",
      idempotencyKey: "send-custom",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    };
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "source",
      sessionKey: "custom-source-session",
      gatewayMethods: ["agent"],
      sessionsSendDelegation: {
        targetAgentId: "ops",
        targetSessionKey: "custom-ops-session",
        request,
        turnAuthority,
      },
    });

    await expect(runtimeToken.verifyAgentRuntimeIdentityToken(token)).resolves.toMatchObject({
      agentId: "source",
      sessionKey: "custom-source-session",
      sessionsSendDelegation: {
        targetAgentId: "ops",
        targetSessionKey: "custom-ops-session",
        requestDigest: runtimeToken.digestSessionsSendAgentRequest(request),
      },
    });
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "custom-source-session",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "ops",
          targetSessionKey: "custom-ops-session",
          request: { ...request, agentId: undefined },
          turnAuthority,
        },
      }),
    ).rejects.toThrow("exact target");
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "custom-source-session",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "ops",
          targetSessionKey: "custom-ops-session",
          request: { ...request, agentId: "main" },
          turnAuthority,
        },
      }),
    ).rejects.toThrow("exact target");
  });

  it("rejects malformed agent session keys at mint and verify boundaries", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { createTurnAuthoritySnapshot } = await import("../plugins/turn-authority.js");
    const turnAuthority = createTurnAuthoritySnapshot({
      principal: { kind: "sender", senderId: "maintainer", senderIsOwner: false },
      agentId: "source",
      sessionKey: "agent:source:main",
    });
    const request = {
      message: "hello",
      sessionKey: "agent::broken",
      agentId: "ops",
      idempotencyKey: "send-malformed",
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    };

    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "source",
        sessionKey: "agent:source:main",
        gatewayMethods: ["agent"],
        sessionsSendDelegation: {
          targetAgentId: "ops",
          targetSessionKey: "agent::broken",
          request,
          turnAuthority,
        },
      }),
    ).rejects.toThrow("exact target");
    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "ops",
        sessionKey: "agent::broken",
        gatewayMethods: ["wake"],
      }),
    ).rejects.toThrow("valid session key");

    await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      gatewayMethods: ["wake"],
    });
    const signedMalformedToken = signAgentRuntimePayload(home, {
      kind: "agentRuntime",
      agentId: "ops",
      sessionKey: "agent::broken",
      gatewayMethods: ["wake"],
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(signedMalformedToken),
    ).resolves.toBeUndefined();
  });

  it("rejects canonical session keys bound to another agent at mint and verify boundaries", async () => {
    const home = useTempHome();
    const runtimeToken = await importRuntimeTokenModule();

    await expect(
      runtimeToken.mintAgentRuntimeIdentityToken({
        agentId: "ops",
        sessionKey: "agent:main:main",
        gatewayMethods: ["wake"],
      }),
    ).rejects.toThrow("session key bound to its agent");

    await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "ops",
      sessionKey: "agent:ops:main",
      gatewayMethods: ["wake"],
    });
    const signedMismatchedToken = signAgentRuntimePayload(home, {
      kind: "agentRuntime",
      agentId: "ops",
      sessionKey: "agent:main:main",
      gatewayMethods: ["wake"],
    });
    await expect(
      runtimeToken.verifyAgentRuntimeIdentityToken(signedMismatchedToken),
    ).resolves.toBeUndefined();
  });

  it("queues parallel verifications behind a same-process approvals update", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["wake"],
    });
    let verifications: Array<ReturnType<typeof runtimeToken.verifyAgentRuntimeIdentityToken>> = [];

    await updateExecApprovals({
      update: () => {
        // Verification can begin while another parallel agent call still owns
        // the process-local approvals lock. It must queue behind that owner.
        verifications = Array.from({ length: 8 }, () =>
          runtimeToken.verifyAgentRuntimeIdentityToken(token),
        );
        return null;
      },
    });

    await expect(Promise.all(verifications)).resolves.toEqual(
      Array.from({ length: 8 }, () => ({
        kind: "agentRuntime",
        agentId: "main",
        sessionKey: "session-1",
        gatewayMethods: ["wake"],
      })),
    );
  });

  it("rechecks message action expiry after waiting for an approvals update", async () => {
    useTempHome();
    const runtimeToken = await importRuntimeTokenModule();
    const { updateExecApprovals } = await import("../infra/exec-approvals.js");
    const token = await runtimeToken.mintAgentRuntimeIdentityToken({
      agentId: "main",
      sessionKey: "session-1",
      gatewayMethods: ["message.action"],
      messageActionContext: { expiresAtMs: 5000 },
    });
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(4000);
    let verification!: ReturnType<typeof runtimeToken.verifyAgentRuntimeIdentityToken>;

    await updateExecApprovals({
      update: () => {
        verification = runtimeToken.verifyAgentRuntimeIdentityToken(token);
        nowSpy.mockReturnValue(5000);
        return null;
      },
    });

    await expect(verification).resolves.toBeUndefined();
  });
});
