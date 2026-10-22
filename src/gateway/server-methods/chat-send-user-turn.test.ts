import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { createSolidPngBuffer } from "../../../test/helpers/image-fixtures.js";
import { hydratePromptMediaMessages } from "../../agents/embedded-agent-runner/run/images.js";
import { normalizeCommandBody } from "../../auto-reply/commands-registry.js";
import { finalizeInboundContext } from "../../auto-reply/reply/inbound-context.js";
import { buildInboundUserContextPrefix } from "../../auto-reply/reply/inbound-meta.js";
import { resolveSessionResetCommand } from "../../auto-reply/reply/session-reset-command.js";
import type { MsgContext } from "../../auto-reply/templating.js";
import { resolveStateDir } from "../../config/paths.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import {
  listSessionParticipantsReadOnly,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { recordAcceptedSessionParticipantInput } from "../../sessions/session-participant-input-recording.js";
import {
  isSessionPersonalBootstrapTurn,
  prepareChannelParticipantObservation,
} from "../../sessions/session-participant-input.js";
import { waitForSessionParticipantRecording } from "../../sessions/session-participant-recording.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import { prepareUserProfileCatalog } from "../../state/user-profile-list.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../../state/user-profiles.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import * as chatAttachments from "../chat-attachments.js";
import { prepareTurn } from "./chat-send-user-turn-family.test-support.js";
import { applyChatSendManagedMedia } from "./chat-send-user-turn.js";
import { createClientInfo, createAttachments } from "./chat-send-user-turn.test-support.js";

function uiClientInfo(mode: typeof GATEWAY_CLIENT_MODES.UI | typeof GATEWAY_CLIENT_MODES.WEBCHAT) {
  return createClientInfo({ id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode });
}

function imageRef(
  id: string,
  mediaPath: string,
  overrides: Partial<ReturnType<typeof createAttachments>["offloadedRefs"][number]> = {},
): ReturnType<typeof createAttachments>["offloadedRefs"][number] {
  return {
    id,
    path: mediaPath,
    mediaRef: `media://inbound/${id}`,
    kind: "image",
    mimeType: "image/png",
    label: "image.png",
    sizeBytes: 10,
    sourceIndex: 0,
    ...overrides,
  };
}

function clientProfile(profileId: string, displayName: string | null, updatedAt = 1) {
  return { profileId, displayName, hasAvatar: false, updatedAt };
}

function requesterProfile(text: string) {
  const json = text.match(/```json\n([\s\S]*?)\n```/u)?.[1];
  return json
    ? (JSON.parse(json) as { requester_profile?: { id: string; display_name: string } })
        .requester_profile
    : undefined;
}

describe("prepareChatSendUserTurn", () => {
  it.each([
    { profileId: "profile-ada", synthetic: false, verified: true },
    { profileId: "profile-ada", synthetic: true, verified: true },
    { profileId: "profile-ada", synthetic: false, verified: false },
  ])("projects only the verified requester: %j", ({ profileId, synthetic, verified }) => {
    const prepared = prepareTurn({
      inputText: "/status",
      request: {
        inboundMessage: "/status",
        clientInfo: uiClientInfo(GATEWAY_CLIENT_MODES.UI),
      },
      attachments: { parsedMessage: "/status" },
      client: {
        authenticatedUserId: verified ? "ada@example.test" : undefined,
        authenticatedUserProfile: clientProfile(profileId, "Ada"),
        internal: synthetic ? { syntheticClient: true } : undefined,
        connect: {
          minProtocol: 1,
          maxProtocol: 1,
          client: createClientInfo({ id: GATEWAY_CLIENT_IDS.CONTROL_UI }),
          scopes: ["operator.write"],
        },
      },
    });
    const ctx = finalizeInboundContext({ ...prepared.ctx });
    const prompt = buildInboundUserContextPrefix(ctx);
    if (verified && !synthetic) {
      expect(requesterProfile(prompt)).toEqual({ id: profileId, display_name: "Ada" });
    } else {
      expect(prompt).not.toContain("requester_profile");
    }
    expect(prepared.ctx).not.toHaveProperty("SenderId");
  });

  it.each(["profile", "synthetic", "profileless", "profileless-ui", "system"] as const)(
    "records only accepted authenticated external input after retargeting: %s",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        setRuntimeConfigSnapshot({});
        const profile = ensureProfileForEmail("accepted@example.test", { env: state.env });
        const creator = ensureProfileForEmail("session-creator@example.test", { env: state.env });
        const clientInfo = createClientInfo(
          kind === "profileless-ui"
            ? { id: GATEWAY_CLIENT_IDS.CONTROL_UI, mode: GATEWAY_CLIENT_MODES.WEBCHAT }
            : {},
        );
        const prepared = prepareTurn({
          request: {
            clientInfo,
            systemInputProvenance:
              kind === "system" ? { kind: "internal_system", sourceTool: "fixture" } : undefined,
          },
          session: { agentId: "main", clientRunId: "accepted", sessionKey: "agent:main:original" },
          client: {
            ...(!kind.startsWith("profileless")
              ? {
                  authenticatedUserProfile: clientProfile(
                    profile.id,
                    profile.displayName,
                    profile.updatedAt,
                  ),
                }
              : {}),
            internal: kind === "synthetic" ? { syntheticClient: true } : undefined,
            connect: {
              minProtocol: 1,
              maxProtocol: 1,
              client: clientInfo,
              scopes: ["operator.write"],
            },
          },
          logGateway: createSubsystemLogger("test/participant"),
        });
        const scope = { agentId: "main", env: state.env, sessionKey: "agent:main:retargeted" };
        await upsertSessionEntryCore(scope, {
          sessionId: "retargeted",
          updatedAt: 2,
          createdActor: { type: "human", source: "profile", id: creator.id },
        });
        const target = {
          agentId: "main",
          sessionKey: scope.sessionKey,
          storePath: state.statePath("agents", "main", "agent", "openclaw-agent.sqlite"),
        };
        // Sender labels do not grant eligibility for personal bootstrap.
        prepared.ctx.SenderId = profile.id;
        prepared.ctx.SenderName = profile.id;
        expect(isSessionPersonalBootstrapTurn({ ...prepared.ctx })).toBe(
          kind === "profile" || kind === "profileless",
        );
        prepareChannelParticipantObservation(prepared.ctx);
        recordAcceptedSessionParticipantInput({ ...prepared.ctx }, target);
        recordAcceptedSessionParticipantInput(prepared.ctx, target);
        await waitForSessionParticipantRecording(target);
        const identity =
          kind === "profile"
            ? { type: "profile", id: profile.id }
            : {
                type: "observation",
                pluginId: null,
                accountId: null,
                senderKind: "unknown",
                id: clientInfo.id,
              };
        expect(listSessionParticipantsReadOnly(scope).get(scope.sessionKey)).toEqual(
          kind === "profile" || kind === "profileless"
            ? [{ identity, contributionCount: 1, firstPromptedAt: 1, lastPromptedAt: 1 }]
            : undefined,
        );
        expect(
          listSessionParticipantsReadOnly({ ...scope, sessionKey: "agent:main:original" }).size,
        ).toBe(0);
      });
    },
  );

  it.each([false, true])(
    "preserves sandbox policy for attributed chat (system actor: %s)",
    async (systemActor) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        setRuntimeConfigSnapshot({});
        const profile = systemActor
          ? ensureGatewayOwnerProfile("Gateway Owner")
          : ensureProfileForEmail("chat-sandbox-creator@example.com");
        using _ = { [Symbol.dispose]: (await prepareUserProfileCatalog()).release };
        const prepared = prepareTurn({
          session: {
            sessionKey: "agent:main:dashboard:guest-chat",
            cfg: {
              gateway: {
                roles: {
                  default: "guest",
                  definitions: {
                    guest: {
                      sessions: { others: "view" },
                      agents: "*",
                      scopes: ["operator.write"],
                      sandbox: "required",
                    },
                  },
                },
              },
            },
          },
          client: {
            ...(systemActor ? { internal: { operatorRoleActor: { kind: "system" } } } : {}),
            authenticatedUserProfile: clientProfile(
              profile.id,
              profile.displayName,
              profile.updatedAt,
            ),
            connect: { scopes: ["operator.write"] },
          } as never,
        });

        await prepared.prepareSessionCreation();
        expect(prepared.ctx.SessionCreation).toEqual({
          via: "operator",
          actor: { type: "human", source: "profile", id: profile.id },
          ...(systemActor ? {} : { sandbox: "required" }),
          skillLibrarySelections: [],
        });
      });
    },
  );

  it.each([
    { name: "status", inboundMessage: "/status", suppressed: false },
    {
      name: "multiline skill",
      inboundMessage: "/skill weather\n  first\n  second",
      suppressed: false,
    },
    { name: "reset", inboundMessage: "/reset\ninspect this", suppressed: false },
    { name: "suppressed status", inboundMessage: "/status", suppressed: true },
  ])(
    "separates $name command input from attachment text while preserving turn facts",
    async ({ inboundMessage, suppressed }) => {
      const parsedMessage = `${inboundMessage}\n[media attached: media://inbound/voice.mp3]`;
      const prepared = prepareTurn({
        inputText: inboundMessage,
        request: {
          inboundMessage,
          suppressCommandInterpretation: suppressed,
          systemInputProvenance: { kind: "internal_system", sourceTool: "test" },
          systemProvenanceReceipt: "[System receipt]",
        },
        attachments: { parsedMessage },
      });

      expect(prepared.ctx).toMatchObject({
        Body: `[System receipt]\n\n${parsedMessage}`,
        BodyForAgent: `[System receipt]\n\n${parsedMessage}`,
        BodyForCommands: inboundMessage,
        CommandBody: inboundMessage,
        RawBody: parsedMessage,
        CommandAuthorized: !suppressed,
        CommandTurn: {
          kind: suppressed ? "normal" : "text-slash",
          source: suppressed ? "message" : "text",
          authorized: !suppressed,
          body: inboundMessage,
        },
        InputProvenance: { kind: "internal_system", sourceTool: "test" },
      });
      expect(prepared.isInternalTextSlashCommandTurn).toBe(!suppressed);
      expect(prepared.ctx.CommandSource).toBe(suppressed ? undefined : "text");
      expect(prepared.ctx.CommandInterpretationSuppressed).toBe(suppressed ? true : undefined);
      const ctx = finalizeInboundContext(prepared.ctx);
      if (inboundMessage.startsWith("/skill")) {
        expect(normalizeCommandBody(ctx.commandText)).toBe("/skill weather\nfirst\n  second");
      }
      if (inboundMessage.startsWith("/reset")) {
        expect(
          resolveSessionResetCommand({
            commandText: ctx.commandText,
            rawText: ctx.rawText,
            resetTriggers: ["/reset"],
            ctx,
            cfg: {},
            agentId: "main",
            isGroup: false,
            resetAuthorized: true,
          }).payload,
        ).toBe("inspect this\n[media attached: media://inbound/voice.mp3]");
      }
      expect(prepared.queuedFollowupOwnerKey).toBeUndefined();
      expect(prepared.replyOptionImages).toBeUndefined();
      await expect(prepared.pluginBoundMediaPromise).resolves.toEqual([]);
      await expect(prepared.readInput()).resolves.toEqual(prepared.baseInput);
    },
  );

  it("carries pre-staged media and device ownership without UI sender decoration", async () => {
    const prepared = prepareTurn({
      request: {
        clientInfo: uiClientInfo(GATEWAY_CLIENT_MODES.UI),
        suppressCommandInterpretation: true,
      },
      attachments: {
        mediaPathOffloads: [
          {
            path: "uploads/report.pdf",
            contentType: "application/pdf",
            workspaceDir: "/workspace",
          },
        ],
      },
      client: {
        connId: "conn-1",
        authenticatedUserProfile: clientProfile("profile-ada", "Ada"),
        connect: {
          client: createClientInfo({ id: GATEWAY_CLIENT_IDS.CONTROL_UI }),
          device: { id: "device-1" },
          scopes: ["operator.admin"],
          caps: ["tool-events"],
        },
      } as never,
    });

    expect(prepared.ctx).toMatchObject({
      CommandAuthorized: false,
      CommandInterpretationSuppressed: true,
      CommandTurn: {
        kind: "normal",
        source: "message",
        authorized: false,
        body: "hello",
      },
      ApprovalReviewerDeviceId: "device-1",
      media: [
        {
          path: "uploads/report.pdf",
          contentType: "application/pdf",
          workspaceDir: "/workspace",
        },
      ],
      GatewayClientScopes: ["operator.admin"],
      GatewayClientCaps: ["tool-events"],
      GatewayUiCommandTarget: { connId: "conn-1", profileId: "profile-ada" },
      SessionCreation: {
        via: "operator",
        actor: { type: "human", id: "profile-ada" },
      },
    });
    expect(prepared.ctx).not.toHaveProperty("SenderId");
    expect(prepared.queuedFollowupOwnerKey).toBe("device:device-1");
    await expect(prepared.readInput()).resolves.toEqual(prepared.baseInput);
  });

  it("preserves source receipts and image hints when approval changes the user text", async () => {
    const mediaRef = "media://inbound/image-1.png";
    const receipt = "[Source Receipt]\nbridge=fixture\n[/Source Receipt]";
    const prepared = prepareTurn({
      inputText: "inspect",
      request: {
        inboundMessage: "inspect",
        systemProvenanceReceipt: receipt,
      },
      attachments: {
        imageOrder: ["offloaded"],
        offloadedRefs: [imageRef("image-1.png", "/media/inbound/image-1.png")],
        parsedMessage: `inspect\n[media attached: ${mediaRef}]`,
      },
    });

    expect(prepared.ctx.Body).toBe(`${receipt}\n\ninspect\n[media attached: ${mediaRef}]`);
    prepared.applyApprovedText("Approved inspect");
    expect(prepared.ctx).toMatchObject({
      Body: `${receipt}\n\nApproved inspect\n[media attached: ${mediaRef}]`,
      BodyForAgent: `${receipt}\n\nApproved inspect\n[media attached: ${mediaRef}]`,
      RawBody: `Approved inspect\n[media attached: ${mediaRef}]`,
      BodyForCommands: "Approved inspect",
      CommandBody: "Approved inspect",
    });
    expect(prepared.replyOptionMedia).toEqual([
      {
        path: "/media/inbound/image-1.png",
        url: mediaRef,
        contentType: "image/png",
      },
    ]);
    await expect(prepared.readInput()).resolves.toMatchObject({
      mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 0 }] },
    });
  });

  it("persists video then image as claim-only facts with the image at fact index one", async () => {
    const prepared = prepareTurn({
      attachments: {
        imageOrder: ["offloaded"],
        offloadedRefs: [
          {
            mediaRef: "https://signed.example/video",
            id: "video.mp4",
            path: "/private/media/video.mp4",
            sourceIndex: 0,
            kind: "video",
            mimeType: "video/mp4",
            label: "video.mp4",
            sizeBytes: 20,
          },
          imageRef("image.png", "/private/media/image.png", {
            mediaRef: "file:///private/image.png",
            sourceIndex: 1,
          }),
        ],
      },
    });

    const input = await prepared.readInput();
    expect(input.media?.map((fact) => fact.kind)).toEqual(["video", "image"]);
    expect(input.mediaImageLayout).toEqual({
      slots: [{ kind: "offloaded", factIndex: 1 }],
    });
    const serialized = JSON.stringify(buildPersistedUserTurnMessage(input));
    expect(serialized).toContain("media://inbound/video.mp4");
    expect(serialized).toContain("media://inbound/image.png");
    for (const privateValue of [
      "/private/media",
      "signed.example",
      "file://",
      "workspaceDir",
      '"data"',
      "base64",
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
  });

  it.each(["inline", "offloaded", "prestaged"] as const)(
    "stages ordinary WebChat %s images exactly once",
    async (kind) => {
      const inline = kind === "inline";
      const prestaged = kind === "prestaged";
      const id = inline ? "photo.png" : prestaged ? "1.png" : "photo---abc.png";
      const persistedPath = prestaged ? "/tmp/1.png" : `/state/media/inbound/${id}`;
      const mediaRef = `media://inbound/${id}`;
      const fileName = inline ? "photo café 雪 🦞.png" : prestaged ? "attachment-1" : "photo.png";
      const sizeBytes = kind === "offloaded" ? 2_100_000 : 10;
      const staged = {
        path: persistedPath,
        contentType: "image/png",
        fileName,
        workspaceDir: "/tmp",
      };
      const persist = prestaged
        ? undefined
        : vi.spyOn(chatAttachments, "persistInboundImagesForTranscript").mockResolvedValueOnce({
            entries: [
              {
                id,
                path: persistedPath,
                sourceIndex: 0,
                imageKind: inline ? "inline" : "offloaded",
                fact: {
                  url: mediaRef,
                  contentType: "image/png",
                  fileName,
                  kind: "image",
                  sizeBytes,
                },
              },
            ],
            omission: "none",
          });
      try {
        const prepared = prepareTurn({
          request: {
            inboundMessage: "inspect",
            clientInfo: uiClientInfo(GATEWAY_CLIENT_MODES.WEBCHAT),
          },
          attachments: {
            imageOrder: [inline ? "inline" : "offloaded"],
            ...(inline
              ? {
                  parsedImages: [
                    { type: "image", data: "aGVsbG8=", mimeType: "image/png", sourceIndex: 0 },
                  ],
                }
              : { offloadedRefs: [imageRef(id, persistedPath, { label: fileName, sizeBytes })] }),
            ...(prestaged ? { mediaPathOffloads: [staged] } : {}),
            ...(kind === "offloaded"
              ? { parsedMessage: `inspect\n[media attached: ${mediaRef}]` }
              : {}),
          },
        });
        const managedMedia = await prepared.pluginBoundMediaPromise;
        if (prestaged) {
          expect(managedMedia).toEqual([]);
          expect(prepared.ctx.media).toEqual([
            {
              path: "/tmp/1.png",
              contentType: "image/png",
              fileName: "attachment-1",
              workspaceDir: "/tmp",
            },
          ]);
          return;
        }
        const expectedMedia = [
          {
            path: persistedPath,
            contentType: "image/png",
            fileName,
            hydrationSuppressed: true,
          },
        ];
        expect(managedMedia).toEqual(expectedMedia);
        if (!inline) {
          expect(prepared.replyOptionImages).toBeUndefined();
          expect(prepared.replyOptionMedia).toEqual([
            { path: persistedPath, url: mediaRef, contentType: "image/png" },
          ]);
        }
        const priorMedia = inline
          ? [{ path: "uploads/report.pdf", workspaceDir: "/workspace" }]
          : [];
        const ctx: MsgContext = inline ? { media: priorMedia } : {};
        applyChatSendManagedMedia(ctx, managedMedia, prepared.managedMediaApplyMode);
        if (inline) {
          applyChatSendManagedMedia(ctx, managedMedia, prepared.managedMediaApplyMode);
        }
        expect(ctx.media).toEqual([
          ...(inline ? [{ path: "uploads/report.pdf", workspaceDir: "/workspace" }] : []),
          ...expectedMedia,
        ]);
      } finally {
        persist?.mockRestore();
      }
    },
  );

  it("hydrates a staged image claim-check alias as structured ownership", async () => {
    const id = `gateway-image-${Date.now()}-${Math.random().toString(36).slice(2)}.png`;
    const imagePath = path.join(resolveStateDir(), "media", "inbound", id);
    const mediaRef = `media://inbound/${id}`;
    const unownedRef = "media://inbound/unowned.png";
    const text = `inspect\n[media attached: ${mediaRef}]\n[media attached: ${unownedRef}]`;
    await fs.mkdir(path.dirname(imagePath), { recursive: true });
    await fs.writeFile(imagePath, createSolidPngBuffer(2, 2, { r: 10, g: 20, b: 30 }));

    try {
      const prepared = prepareTurn({
        request: { inboundMessage: "inspect" },
        attachments: {
          imageOrder: ["offloaded"],
          offloadedRefs: [imageRef(id, imagePath)],
          parsedMessage: text,
        },
      });

      const input = await prepared.readInput();
      const expectedMedia = [
        {
          url: mediaRef,
          contentType: "image/png",
          kind: "image",
          fileName: "image.png",
          sizeBytes: 10,
        },
      ];
      expect(input.media).toEqual(expectedMedia);
      expect(input.media?.[0]).not.toHaveProperty("hydrationSuppressed");
      const persisted = buildPersistedUserTurnMessage({ ...input, text });
      expect(persisted).toHaveProperty("__openclaw.media", expectedMedia);

      const hydrated = await hydratePromptMediaMessages([persisted], {
        workspaceDir: path.dirname(imagePath),
        model: { input: ["text", "image"] },
        workspaceOnly: true,
      });
      expect(hydrated[0]).toHaveProperty("content", [
        { type: "text", text },
        expect.objectContaining({ type: "image", mimeType: "image/png" }),
      ]);
    } finally {
      await fs.rm(imagePath, { force: true });
    }
  });
});
