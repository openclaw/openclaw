import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
  type GatewayClientInfo,
} from "../../../packages/gateway-protocol/src/client-info.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { isIssuedTurnAuthoritySnapshot } from "../../plugins/turn-authority.js";
import type { UserTurnInput } from "../../sessions/user-turn-transcript.js";
import {
  applyChatSendManagedMediaFields,
  createChatSendTurnAuthority,
  prepareChatSendUserTurn,
} from "./chat-send-user-turn.js";

function prepareUserTurn(
  params: Omit<Parameters<typeof prepareChatSendUserTurn>[0], "admission" | "turnAuthority"> & {
    admission: Parameters<typeof createChatSendTurnAuthority>[0]["admission"];
  },
) {
  return prepareChatSendUserTurn({
    ...params,
    turnAuthority: createChatSendTurnAuthority(params),
  });
}

function createUserTurnInputController() {
  const baseInput: UserTurnInput = {
    text: "raw message",
    timestamp: 1,
    idempotencyKey: "run-1:user",
  };
  let inputPromise = Promise.resolve(baseInput);
  return {
    controller: {
      baseInput,
      setInputPromise: (input: Promise<UserTurnInput>) => {
        inputPromise = input;
      },
    },
    readInput: () => inputPromise,
  };
}

function createClientInfo(overrides: Partial<GatewayClientInfo> = {}): GatewayClientInfo {
  return {
    id: GATEWAY_CLIENT_IDS.CLI,
    version: "test",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.CLI,
    ...overrides,
  };
}

function createAttachments(
  overrides: Partial<{
    explicitOriginTargetsPlugin: boolean;
    mediaPathOffloadPaths: string[];
    mediaPathOffloadTypes: string[];
    mediaPathOffloadWorkspaceDir: string | undefined;
    parsedMessage: string;
  }> = {},
) {
  return {
    explicitOriginTargetsPlugin: false,
    imageOrder: [],
    mediaPathOffloadPaths: [],
    mediaPathOffloadTypes: [],
    mediaPathOffloadWorkspaceDir: undefined,
    offloadedRefs: [],
    parsedImages: [],
    parsedMessage: "hello",
    prepareAttachmentsMs: undefined,
    ...overrides,
  };
}

describe("prepareChatSendUserTurn", () => {
  it("assembles command, provenance, sender, and origin facts", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const prepared = prepareUserTurn({
      request: {
        clientInfo: createClientInfo({ displayName: "Gateway CLI" }),
        normalizedAttachments: [],
        suppressCommandInterpretation: false,
        systemInputProvenance: { kind: "internal_system", sourceTool: "test" },
        systemProvenanceReceipt: "[System receipt]",
        toolBindings: { browser: { kind: "tab", targetId: "target-1" } },
      },
      session: {
        agentId: "main",
        clientRunId: "run-1",
        sessionKey: "agent:main:main",
      },
      admission: {
        admittedSessionId: "session-1",
        originatingRoute: {
          originatingChannel: "discord",
          originatingTo: "channel:1",
          accountId: "account-1",
          messageThreadId: "thread-1",
          explicitDeliverRoute: true,
        },
      },
      attachments: createAttachments({ parsedMessage: "/status" }),
      client: null,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    expect(prepared.ctx).toMatchObject({
      Body: "[System receipt]\n\n/status",
      BodyForAgent: "[System receipt]\n\n/status",
      BodyForCommands: "/status",
      RawBody: "/status",
      CommandSource: "text",
      CommandAuthorized: true,
      CommandTurn: {
        kind: "text-slash",
        source: "text",
        authorized: true,
        body: "/status",
      },
      InputProvenance: { kind: "internal_system", sourceTool: "test" },
      GatewayRunToolBindings: { browser: { kind: "tab", targetId: "target-1" } },
      OriginatingChannel: "discord",
      OriginatingTo: "channel:1",
      AccountId: "account-1",
      MessageThreadId: "thread-1",
      ExplicitDeliverRoute: true,
      SenderId: GATEWAY_CLIENT_IDS.CLI,
      SenderName: "Gateway CLI",
      SenderUsername: "Gateway CLI",
    });
    expect(prepared.accountId).toBe("account-1");
    expect(prepared.isInternalTextSlashCommandTurn).toBe(true);
    expect(prepared.queuedFollowupOwnerKey).toBeUndefined();
    expect(prepared.replyOptionImages).toBeUndefined();
    await expect(prepared.pluginBoundMediaFieldsPromise).resolves.toEqual({});
    await expect(readInput()).resolves.toEqual(controller.baseInput);
  });

  it("carries pre-staged media and device ownership without UI sender decoration", async () => {
    const { controller, readInput } = createUserTurnInputController();
    const prepared = prepareUserTurn({
      request: {
        clientInfo: createClientInfo({
          id: GATEWAY_CLIENT_IDS.CONTROL_UI,
          mode: GATEWAY_CLIENT_MODES.UI,
        }),
        normalizedAttachments: [{}],
        suppressCommandInterpretation: true,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
      },
      session: {
        agentId: "main",
        clientRunId: "run-1",
        sessionKey: "agent:main:main",
      },
      admission: {
        admittedSessionId: "session-1",
        originatingRoute: {
          originatingChannel: "webchat",
          explicitDeliverRoute: false,
        },
      },
      attachments: createAttachments({
        mediaPathOffloadPaths: ["uploads/report.pdf"],
        mediaPathOffloadTypes: ["application/pdf"],
        mediaPathOffloadWorkspaceDir: "/workspace",
      }),
      client: {
        connId: "conn-1",
        pairedClientId: "paired-control-ui",
        connect: {
          device: { id: "device-1" },
          scopes: ["operator.admin"],
          caps: ["tool-events"],
        },
      } as never,
      logGateway: { warn: vi.fn() } as never,
      userTurn: controller,
    });

    expect(prepared.ctx).toMatchObject({
      CommandAuthorized: false,
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        body: "hello",
      },
      ApprovalReviewerDeviceId: "device-1",
      MediaPath: "uploads/report.pdf",
      MediaPaths: ["uploads/report.pdf"],
      MediaType: "application/pdf",
      MediaTypes: ["application/pdf"],
      MediaWorkspaceDir: "/workspace",
      MediaStaged: true,
      GatewayClientScopes: ["operator.admin"],
      GatewayClientCaps: ["tool-events"],
    });
    expect(prepared.ctx).not.toHaveProperty("SenderId");
    expect(isIssuedTurnAuthoritySnapshot(prepared.ctx.TurnAuthority)).toBe(true);
    expect(prepared.ctx.TurnAuthority).toMatchObject({
      authorization: {
        sessionId: "session-1",
        principal: {
          kind: "operator",
          scopes: ["operator.admin"],
          clientId: "paired-control-ui",
          deviceId: "device-1",
          isOwner: true,
        },
      },
      controllerKey: "device:device-1",
      capabilityDigest: expect.any(String),
    });
    expect(prepared.queuedFollowupOwnerKey).toBe("device:device-1");
    await expect(readInput()).resolves.toEqual(controller.baseInput);
  });

  it("isolates device-less operators by authenticated connection and scope", () => {
    const prepare = (connId: string, scopes: string[]) => {
      const { controller } = createUserTurnInputController();
      return prepareUserTurn({
        request: {
          clientInfo: createClientInfo({
            id: GATEWAY_CLIENT_IDS.CONTROL_UI,
            mode: GATEWAY_CLIENT_MODES.UI,
          }),
          normalizedAttachments: [],
          suppressCommandInterpretation: false,
        },
        session: { agentId: "main", clientRunId: `run-${connId}`, sessionKey: "agent:main:main" },
        admission: {
          admittedSessionId: "session-1",
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments(),
        client: {
          connId,
          pairedClientId: "paired-control-ui",
          connect: { scopes, caps: [] },
        } as never,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });
    };

    const admin = prepare("conn-admin", ["operator.admin"]);
    const writer = prepare("conn-writer", ["operator.write"]);

    expect(admin.ctx.TurnAuthority?.controllerKey).toBe("connection:conn-admin");
    expect(writer.ctx.TurnAuthority?.controllerKey).toBe("connection:conn-writer");
    expect(admin.ctx.TurnAuthority?.authorization.principal).toMatchObject({
      kind: "operator",
      scopes: ["operator.admin"],
      isOwner: true,
    });
    expect(writer.ctx.TurnAuthority?.authorization.principal).toMatchObject({
      kind: "operator",
      scopes: ["operator.write"],
      isOwner: false,
    });
  });
});

describe("applyChatSendManagedMediaFields", () => {
  it("fills missing staged fields without replacing pre-staged paths", () => {
    const ctx = {
      MediaStaged: true,
      MediaPath: "uploads/report.pdf",
    } as MsgContext;

    applyChatSendManagedMediaFields(ctx, {
      MediaPath: "managed/image.png",
      MediaPaths: ["managed/image.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });

    expect(ctx).toMatchObject({
      MediaPath: "uploads/report.pdf",
      MediaPaths: ["managed/image.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });
});
