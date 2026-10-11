import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { maybeHandleResetCommand } from "../../auto-reply/reply/commands-reset.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import {
  createSqliteTranscriptTarget,
  persistUserTurnTranscript,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import * as chatAttachments from "../chat-attachments.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createAttachments,
  createClientInfo,
  createUserTurnInputController,
} from "./chat-send-user-turn.test-support.js";

const { transcribeAudioAttachments } = vi.hoisted(() => ({ transcribeAudioAttachments: vi.fn() }));
vi.mock("../../media-understanding/audio-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../media-understanding/audio-preflight.js")>()),
  transcribeAudioAttachments,
}));

function requireInputText(input: { text?: string | null }): string {
  if (typeof input.text !== "string") {
    throw new Error("Expected prepared user-turn text");
  }
  return input.text;
}

describe("prepareChatSendUserTurn audio", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  it.each([
    {
      name: "WebChat",
      clientInfo: createClientInfo({
        id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      }),
    },
    {
      name: "Control UI",
      clientInfo: createClientInfo({
        id: GATEWAY_CLIENT_IDS.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.UI,
      }),
    },
    {
      name: "macOS app",
      clientInfo: createClientInfo({
        id: GATEWAY_CLIENT_IDS.MACOS_APP,
        mode: GATEWAY_CLIENT_MODES.UI,
      }),
    },
    {
      name: "iOS app",
      clientInfo: createClientInfo({
        id: GATEWAY_CLIENT_IDS.IOS_APP,
        mode: GATEWAY_CLIENT_MODES.UI,
      }),
    },
    {
      name: "Android app",
      clientInfo: createClientInfo({
        id: GATEWAY_CLIENT_IDS.ANDROID_APP,
        mode: GATEWAY_CLIENT_MODES.UI,
      }),
    },
  ])(
    "persists a configured $name voice transcript in its canonical user turn",
    async ({ clientInfo }) => {
      const persist = vi
        .spyOn(chatAttachments, "persistInboundImagesForTranscript")
        .mockResolvedValueOnce({ entries: [], omission: "none" });
      transcribeAudioAttachments.mockImplementationOnce(async ({ ctx }) => {
        if (ctx.media?.[0]) {
          ctx.media[0] = { ...ctx.media[0], transcribed: true };
        }
        return "transcribed voice";
      });
      try {
        const { controller, readInput } = createUserTurnInputController();
        const scope = {
          default: "allow" as const,
          rules: [{ match: { channel: "webchat" }, action: "allow" as const }],
        };
        const prepared = prepareChatSendUserTurn({
          request: {
            inboundMessage: "raw message",
            clientInfo,
            suppressCommandInterpretation: false,
            systemInputProvenance: undefined,
            systemProvenanceReceipt: undefined,
          },
          session: {
            agentId: "main",
            clientRunId: "run-voice",
            sessionKey: "agent:main:main",
            cfg: {
              tools: {
                media: {
                  audio: {
                    echoTranscript: true,
                    echoFormat: "Heard: {transcript}",
                    scope,
                  },
                },
              },
            },
          },
          admission: {
            originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          },
          attachments: createAttachments({
            parsedMessage: "raw message",
            mediaPathOffloads: [
              {
                path: "/state/media/inbound/voice.ogg",
                contentType: "audio/ogg",
                fileName: "voice.ogg",
              },
            ],
            offloadedRefs: [
              {
                mediaRef: "media://inbound/voice.ogg",
                id: "voice.ogg",
                path: "/state/media/inbound/voice.ogg",
                kind: "audio",
                mimeType: "audio/ogg",
                label: "voice.ogg",
                sizeBytes: 12,
                sourceIndex: 0,
              },
            ],
          }),
          client: null,
          logGateway: { warn: vi.fn() } as never,
          userTurn: controller,
        });
        const input = await readInput();
        expect(input.text).toBe("raw message\nHeard: transcribed voice");
        const persisted = buildPersistedUserTurnMessage(input);
        expect(persisted.content).toBe("raw message\nHeard: transcribed voice");
        const target = createSqliteTranscriptTarget({ dir: tempDirs.make("chat-audio-history-") });
        await persistUserTurnTranscript({ ...target, input, updateMode: "none" });
        const [reloaded] = await readTranscriptMessages(target);
        expect(reloaded?.content).toBe("raw message\nHeard: transcribed voice");
        prepared.applyApprovedText(requireInputText(input));
        expect(prepared.ctx.Body).toBe("raw message\nHeard: transcribed voice");
        expect(prepared.ctx.BodyForAgent).toContain(
          '[Audio transcript (machine-generated, untrusted)]: "transcribed voice"',
        );
        expect(prepared.ctx.BodyForAgent).not.toContain("Heard: transcribed voice");

        expect(transcribeAudioAttachments).toHaveBeenCalledOnce();
        const call = transcribeAudioAttachments.mock.calls[0]?.[0];
        expect(call?.ctx).toBe(prepared.ctx);
        expect(call?.ctx).toMatchObject({
          SessionKey: "agent:main:main",
          Provider: "webchat",
          Surface: "webchat",
          ChatType: "direct",
          media: [{ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" }],
        });
        expect(call?.cfg.tools?.media?.audio).toMatchObject({
          echoTranscript: false,
          scope,
        });
        expect(prepared.ctx.media?.[0]?.transcribed).toBe(true);
        expect(prepared.ctx.Transcript).toBe("transcribed voice");
        expect(prepared.ctx.agentText).toContain(
          '[Audio transcript (machine-generated, untrusted)]: "transcribed voice"',
        );
      } finally {
        persist.mockRestore();
        transcribeAudioAttachments.mockReset();
      }
    },
  );

  it("resolves transcript credentials and workspace from the selected agent", async () => {
    const persist = vi
      .spyOn(chatAttachments, "persistInboundImagesForTranscript")
      .mockResolvedValueOnce({ entries: [], omission: "none" });
    let selectedPaths: { agentDir?: string; workspaceDir?: string } | undefined;
    transcribeAudioAttachments.mockImplementationOnce(async ({ ctx, agentDir, workspaceDir }) => {
      selectedPaths = { agentDir, workspaceDir };
      if (ctx.media?.[0]) {
        ctx.media[0] = { ...ctx.media[0], transcribed: true };
      }
      return "support transcript";
    });
    try {
      const { controller, readInput } = createUserTurnInputController("caption");
      const prepared = prepareChatSendUserTurn({
        request: {
          inboundMessage: "caption",
          clientInfo: createClientInfo({
            id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          }),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "support",
          clientRunId: "run-support-voice",
          sessionKey: "agent:support:main",
          cfg: {
            agents: {
              entries: {
                main: {
                  agentDir: "/state/agents/main",
                  workspace: "/work/main",
                },
                support: {
                  agentDir: "/state/agents/support",
                  workspace: "/work/support",
                },
              },
            },
            tools: {
              media: {
                audio: {
                  echoTranscript: true,
                  echoFormat: "Heard: {transcript}",
                  scope: { default: "allow" },
                },
              },
            },
          },
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments({
          parsedMessage: "caption",
          mediaPathOffloads: [
            {
              path: "/state/media/inbound/support-voice.ogg",
              contentType: "audio/ogg",
              fileName: "support-voice.ogg",
            },
          ],
          offloadedRefs: [
            {
              mediaRef: "media://inbound/support-voice.ogg",
              id: "support-voice.ogg",
              path: "/state/media/inbound/support-voice.ogg",
              kind: "audio",
              mimeType: "audio/ogg",
              label: "support-voice.ogg",
              sizeBytes: 12,
              sourceIndex: 0,
            },
          ],
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      const input = await readInput();
      expect(input.text).toBe("caption\nHeard: support transcript");
      expect(prepared.ctx.AgentId).toBe("support");
      expect(selectedPaths).toEqual({
        agentDir: "/state/agents/support",
        workspaceDir: "/work/support",
      });
      expect(selectedPaths).not.toEqual({
        agentDir: "/state/agents/main",
        workspaceDir: "/work/main",
      });
    } finally {
      persist.mockRestore();
      transcribeAudioAttachments.mockReset();
    }
  });

  it.each(["Voice note received", ""])(
    "leaves audio processing to the normal pipeline for echo format %j",
    async (echoFormat) => {
      const persist = vi
        .spyOn(chatAttachments, "persistInboundImagesForTranscript")
        .mockResolvedValueOnce({ entries: [], omission: "none" });
      transcribeAudioAttachments.mockImplementationOnce(async ({ ctx }) => {
        if (ctx.media?.[0]) {
          ctx.media[0] = { ...ctx.media[0], transcribed: true };
        }
        return "unapproved transcript";
      });
      try {
        const { controller, readInput } = createUserTurnInputController("caption");
        const prepared = prepareChatSendUserTurn({
          request: {
            inboundMessage: "caption",
            clientInfo: createClientInfo({
              id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            }),
            suppressCommandInterpretation: false,
            systemInputProvenance: undefined,
            systemProvenanceReceipt: undefined,
          },
          session: {
            agentId: "main",
            clientRunId: "run-voice-static-echo",
            sessionKey: "agent:main:main",
            cfg: {
              tools: {
                media: { audio: { echoTranscript: true, echoFormat } },
              },
            },
          },
          admission: {
            originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          },
          attachments: createAttachments({
            parsedMessage: "caption",
            mediaPathOffloads: [
              { path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" },
            ],
          }),
          client: null,
          logGateway: { warn: vi.fn() } as never,
          userTurn: controller,
        });

        const input = await readInput();
        expect(input.text).toBe("caption");
        expect(transcribeAudioAttachments).not.toHaveBeenCalled();
        expect(prepared.ctx.media?.[0]?.transcribed).not.toBe(true);
        prepared.applyApprovedText(requireInputText(input));
        expect(prepared.ctx.BodyForAgent).toBe("caption");
        expect(prepared.ctx.BodyForAgent).not.toContain("unapproved transcript");
      } finally {
        persist.mockRestore();
        transcribeAudioAttachments.mockReset();
      }
    },
  );

  it("does not reintroduce a transcript removed by the approval hook", async () => {
    const persist = vi
      .spyOn(chatAttachments, "persistInboundImagesForTranscript")
      .mockResolvedValueOnce({ entries: [], omission: "none" });
    transcribeAudioAttachments.mockImplementationOnce(async ({ ctx }) => {
      if (ctx.media?.[0]) {
        ctx.media[0] = { ...ctx.media[0], transcribed: true };
      }
      return "private transcript";
    });
    try {
      const { controller, readInput } = createUserTurnInputController("caption");
      const prepared = prepareChatSendUserTurn({
        request: {
          inboundMessage: "caption",
          clientInfo: createClientInfo({
            id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          }),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "run-voice-redaction",
          sessionKey: "agent:main:main",
          cfg: {
            tools: {
              media: {
                audio: { echoTranscript: true, echoFormat: "Heard: {transcript}" },
              },
            },
          },
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments({
          parsedMessage: "caption",
          mediaPathOffloads: [{ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" }],
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      await expect(readInput()).resolves.toMatchObject({
        text: "caption\nHeard: private transcript",
      });
      prepared.applyApprovedText("caption");
      expect(prepared.ctx.BodyForAgent).toBe("caption");
      expect(prepared.ctx.BodyForAgent).not.toContain("private transcript");
      expect(prepared.ctx.Transcript).toBeUndefined();

      prepared.applyApprovedText("caption\nHeard: [redacted]");
      expect(prepared.ctx.BodyForAgent).toBe("caption\nHeard: [redacted]");
      expect(prepared.ctx.BodyForAgent).not.toContain("private transcript");
      expect(prepared.ctx.Transcript).toBeUndefined();
    } finally {
      persist.mockRestore();
      transcribeAudioAttachments.mockReset();
    }
  });

  it.each(["none", "inline-image-save-failed"] as const)(
    "preserves approved caption and untrusted speech with media omission %s",
    async (omission) => {
      const persist = vi
        .spyOn(chatAttachments, "persistInboundImagesForTranscript")
        .mockResolvedValueOnce({ entries: [], omission });
      transcribeAudioAttachments.mockImplementationOnce(async ({ ctx }) => {
        if (ctx.media?.[0]) {
          ctx.media[0] = { ...ctx.media[0], transcribed: true };
        }
        return "approved transcript";
      });
      try {
        const { controller, readInput } = createUserTurnInputController("a longer caption");
        const prepared = prepareChatSendUserTurn({
          request: {
            inboundMessage: "a longer caption",
            clientInfo: createClientInfo({
              id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            }),
            suppressCommandInterpretation: false,
            systemInputProvenance: undefined,
            systemProvenanceReceipt: undefined,
          },
          session: {
            agentId: "main",
            clientRunId: "run-voice-short-caption",
            sessionKey: "agent:main:main",
            cfg: {
              tools: {
                media: {
                  audio: { echoTranscript: true, echoFormat: "Heard: {transcript}" },
                },
              },
            },
          },
          admission: {
            originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          },
          attachments: createAttachments({
            parsedMessage: "a longer caption",
            imageOrder: ["inline"],
            parsedImages: [
              { type: "image", data: "aGVsbG8=", mimeType: "image/png", sourceIndex: 0 },
            ],
            mediaPathOffloads: [
              { path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" },
            ],
          }),
          client: null,
          logGateway: { warn: vi.fn() } as never,
          userTurn: controller,
        });

        const input = await readInput();
        expect(input.text).toContain("a longer caption\nHeard: approved transcript");
        const omissionSuffix =
          omission === "inline-image-save-failed"
            ? "\n[image attachment omitted: durable managed media claim unavailable]"
            : "";
        expect(input.text).toBe("a longer caption\nHeard: approved transcript" + omissionSuffix);
        prepared.applyApprovedText("x\nHeard: approved transcript" + omissionSuffix);
        expect(prepared.ctx.BodyForAgent).toBe(
          'x\n[Audio transcript (machine-generated, untrusted)]: "approved transcript"' +
            omissionSuffix,
        );
        expect(prepared.ctx.BodyForAgent).not.toContain("Heard:");
        expect(prepared.ctx.CommandBody).toBe("x");
        expect(prepared.ctx.BodyForCommands).toBe("x");
        expect(prepared.ctx.RawBody).toBe("x");
        expect(prepared.ctx.CommandTurn?.body).toBe("x");
      } finally {
        persist.mockRestore();
        transcribeAudioAttachments.mockReset();
      }
    },
  );

  it.each(["", null, undefined])(
    "keeps transcript echo out of command parsing after approval with base text %s",
    async (baseText) => {
      const persist = vi
        .spyOn(chatAttachments, "persistInboundImagesForTranscript")
        .mockResolvedValueOnce({ entries: [], omission: "none" });
      transcribeAudioAttachments.mockImplementationOnce(async ({ ctx }) => {
        if (ctx.media?.[0]) {
          ctx.media[0] = { ...ctx.media[0], transcribed: true };
        }
        return "/reset";
      });
      try {
        const { controller, readInput } = createUserTurnInputController("");
        controller.baseInput.text = baseText;
        const prepared = prepareChatSendUserTurn({
          request: {
            inboundMessage: "",
            clientInfo: createClientInfo({
              id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
              mode: GATEWAY_CLIENT_MODES.WEBCHAT,
            }),
            suppressCommandInterpretation: false,
            systemInputProvenance: undefined,
            systemProvenanceReceipt: undefined,
          },
          session: {
            agentId: "main",
            clientRunId: "run-voice-command",
            sessionKey: "agent:main:main",
            cfg: {
              tools: {
                media: { audio: { echoTranscript: true, echoFormat: "Heard: {transcript}" } },
              },
            },
          },
          admission: {
            originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          },
          attachments: createAttachments({
            parsedMessage: "",
            mediaPathOffloads: [
              { path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" },
            ],
            offloadedRefs: [
              {
                mediaRef: "media://inbound/voice.ogg",
                id: "voice.ogg",
                path: "/state/media/inbound/voice.ogg",
                kind: "audio",
                mimeType: "audio/ogg",
                label: "voice.ogg",
                sizeBytes: 12,
                sourceIndex: 0,
              },
            ],
          }),
          client: null,
          logGateway: { warn: vi.fn() } as never,
          userTurn: controller,
        });
        const input = await readInput();
        expect(input.text).toBe("Heard: /reset");
        prepared.applyApprovedText(requireInputText(input));
        expect(prepared.ctx.Body).toBe("Heard: /reset");
        expect(prepared.ctx.BodyForAgent).toBe(
          '[Audio transcript (machine-generated, untrusted)]: "/reset"',
        );
        expect(prepared.ctx.CommandTurn).toMatchObject({ kind: "normal", body: "" });
        expect(prepared.ctx.CommandBody).toBe("");
        expect(prepared.ctx.BodyForCommands).toBe("");
        expect(prepared.ctx.RawBody).toBe("");
        expect(prepared.ctx.CommandSource).toBeUndefined();
        expect(prepared.isInternalTextSlashCommandTurn).toBe(false);
        expect(prepared.ctx.media?.[0]?.transcribed).toBe(true);
      } finally {
        persist.mockRestore();
        transcribeAudioAttachments.mockReset();
      }
    },
  );

  it("does not dispatch a raw slash command from a transcript-only echo", async () => {
    const persist = vi
      .spyOn(chatAttachments, "persistInboundImagesForTranscript")
      .mockResolvedValueOnce({ entries: [], omission: "none" });
    transcribeAudioAttachments.mockImplementationOnce(async ({ ctx }) => {
      if (ctx.media?.[0]) {
        ctx.media[0] = { ...ctx.media[0], transcribed: true };
      }
      return "/reset";
    });
    try {
      const { controller, readInput } = createUserTurnInputController("");
      const sessionEntry = { sessionId: "voice-session", updatedAt: 1 };
      const prepared = prepareChatSendUserTurn({
        request: {
          inboundMessage: "",
          clientInfo: createClientInfo({
            id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          }),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "run-voice-raw-slash",
          sessionKey: "agent:main:main",
          cfg: {
            commands: { text: true },
            tools: { media: { audio: { echoTranscript: true, echoFormat: "{transcript}" } } },
          },
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments({
          parsedMessage: "",
          mediaPathOffloads: [{ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" }],
          offloadedRefs: [
            {
              mediaRef: "media://inbound/voice.ogg",
              id: "voice.ogg",
              path: "/state/media/inbound/voice.ogg",
              kind: "audio",
              mimeType: "audio/ogg",
              label: "voice.ogg",
              sizeBytes: 12,
              sourceIndex: 0,
            },
          ],
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });

      const input = await readInput();
      expect(input.text).toBe("/reset");
      prepared.applyApprovedText(requireInputText(input));
      expect(prepared.ctx.Body).toBe("/reset");
      expect(prepared.ctx.BodyForAgent).toContain(
        '[Audio transcript (machine-generated, untrusted)]: "/reset"',
      );
      expect(prepared.ctx.CommandTurn).toMatchObject({ kind: "normal", body: "" });
      expect(prepared.ctx.CommandBody).toBe("");
      expect(prepared.ctx.BodyForCommands).toBe("");
      expect(prepared.ctx.RawBody).toBe("");

      const commandParams = buildCommandTestParams(
        prepared.ctx.CommandBody ?? "",
        {
          commands: { text: true },
        },
        prepared.ctx,
      );
      commandParams.sessionEntry = sessionEntry;
      commandParams.sessionStore = { [commandParams.sessionKey]: sessionEntry };
      const result = await maybeHandleResetCommand(commandParams);
      expect(result).toBeNull();
      expect(sessionEntry).toEqual({ sessionId: "voice-session", updatedAt: 1 });
    } finally {
      persist.mockRestore();
      transcribeAudioAttachments.mockReset();
    }
  });

  it("refuses a transcript when UI media admission expires during preflight", async () => {
    const persist = vi
      .spyOn(chatAttachments, "persistInboundImagesForTranscript")
      .mockResolvedValueOnce({ entries: [], omission: "none" });
    const assertClientUploadAllowed = vi.fn(() => {
      if (assertClientUploadAllowed.mock.calls.length === 2) {
        throw new Error("admission expired");
      }
    });
    transcribeAudioAttachments.mockResolvedValueOnce("uncommitted voice");
    try {
      const { controller, readInput } = createUserTurnInputController("");
      const prepared = prepareChatSendUserTurn({
        request: {
          inboundMessage: "",
          clientInfo: createClientInfo({
            id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
            mode: GATEWAY_CLIENT_MODES.WEBCHAT,
          }),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "run-voice-admission",
          sessionKey: "agent:main:main",
          cfg: { tools: { media: { audio: { echoTranscript: true } } } },
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
          assertClientUploadAllowed,
        },
        attachments: createAttachments({
          parsedMessage: "",
          mediaPathOffloads: [{ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" }],
          offloadedRefs: [
            {
              mediaRef: "media://inbound/voice.ogg",
              id: "voice.ogg",
              path: "/state/media/inbound/voice.ogg",
              kind: "audio",
              mimeType: "audio/ogg",
              label: "voice.ogg",
              sizeBytes: 12,
              sourceIndex: 0,
            },
          ],
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });
      await expect(readInput()).rejects.toThrow("admission expired");
      expect(transcribeAudioAttachments).toHaveBeenCalledOnce();
      expect(prepared.ctx.Transcript).toBeUndefined();
      expect(assertClientUploadAllowed).toHaveBeenCalledTimes(2);
    } finally {
      persist.mockRestore();
      transcribeAudioAttachments.mockReset();
    }
  });

  it("does not preflight voice attachments for non-chat clients", async () => {
    const persist = vi
      .spyOn(chatAttachments, "persistInboundImagesForTranscript")
      .mockResolvedValueOnce({ entries: [], omission: "none" });
    transcribeAudioAttachments.mockResolvedValueOnce("must not run");
    try {
      const { controller, readInput } = createUserTurnInputController();
      prepareChatSendUserTurn({
        request: {
          inboundMessage: "",
          clientInfo: createClientInfo(),
          suppressCommandInterpretation: false,
          systemInputProvenance: undefined,
          systemProvenanceReceipt: undefined,
        },
        session: {
          agentId: "main",
          clientRunId: "run-voice",
          sessionKey: "agent:main:main",
          cfg: { tools: { media: { audio: { echoTranscript: true } } } },
        },
        admission: {
          originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
        },
        attachments: createAttachments({
          mediaPathOffloads: [{ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" }],
        }),
        client: null,
        logGateway: { warn: vi.fn() } as never,
        userTurn: controller,
      });
      await expect(readInput()).resolves.toMatchObject({ text: "raw message" });
      expect(transcribeAudioAttachments).not.toHaveBeenCalled();
    } finally {
      persist.mockRestore();
      transcribeAudioAttachments.mockReset();
    }
  });
});
