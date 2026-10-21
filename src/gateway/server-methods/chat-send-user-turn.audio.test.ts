import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { maybeHandleResetCommand } from "../../auto-reply/reply/commands-reset.js";
import { buildCommandTestParams } from "../../auto-reply/reply/commands.test-harness.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { buildPersistedUserTurnMessage } from "../../sessions/user-turn-transcript.js";
import {
  createSqliteTranscriptTarget,
  persistUserTurnTranscript,
  readTranscriptMessages,
} from "../../sessions/user-turn-transcript.test-support.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
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

type TurnParams = Parameters<typeof prepareChatSendUserTurn>[0];
function prepareVoice(
  userTurn: TurnParams["userTurn"],
  {
    text = "caption",
    clientInfo = createClientInfo({
      id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    }),
    agentId = "main",
    sessionKey = "agent:main:main",
    cfg = {
      tools: { media: { audio: { echoTranscript: true, echoFormat: "Heard: {transcript}" } } },
    },
    attachments,
    assertClientUploadAllowed,
  }: {
    text?: string;
    clientInfo?: TurnParams["request"]["clientInfo"];
    agentId?: string;
    sessionKey?: string;
    cfg?: TurnParams["session"]["cfg"];
    attachments?: Partial<TurnParams["attachments"]>;
    assertClientUploadAllowed?: TurnParams["admission"]["assertClientUploadAllowed"];
  } = {},
) {
  return prepareChatSendUserTurn({
    request: {
      inboundMessage: text,
      clientInfo,
      suppressCommandInterpretation: false,
      systemInputProvenance: undefined,
      systemProvenanceReceipt: undefined,
    },
    session: { agentId, clientRunId: "run-voice", sessionKey, cfg },
    admission: {
      originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
      assertClientUploadAllowed,
    },
    attachments: createAttachments({
      parsedMessage: text,
      mediaPathOffloads: [{ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" }],
      ...attachments,
    }),
    client: null,
    logGateway: { warn: vi.fn() } as never,
    userTurn,
  });
}
function voiceRef(id = "voice.ogg") {
  return {
    mediaRef: `media://inbound/${id}`,
    id,
    path: `/state/media/inbound/${id}`,
    kind: "audio" as const,
    mimeType: "audio/ogg",
    label: id,
    sizeBytes: 12,
    sourceIndex: 0,
  };
}
function mockTranscript(text: string) {
  transcribeAudioAttachments.mockImplementationOnce(async ({ ctx }) => {
    if (ctx.media?.[0]) {
      ctx.media[0] = { ...ctx.media[0], transcribed: true };
    }
    return text;
  });
}
function mockPersistence(
  omission: Awaited<
    ReturnType<typeof chatAttachments.persistInboundImagesForTranscript>
  >["omission"] = "none",
) {
  return vi
    .spyOn(chatAttachments, "persistInboundImagesForTranscript")
    .mockResolvedValueOnce({ entries: [], omission });
}

describe("prepareChatSendUserTurn audio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    transcribeAudioAttachments.mockReset();
  });
  const tempDirs = useSessionStoreTempDirs(
    (cleanup) =>
      afterAll(async () => {
        await cleanup();
        clearRuntimeConfigSnapshot();
      }),
    "chat-audio-history-",
  );
  it.each([
    ["WebChat", GATEWAY_CLIENT_IDS.WEBCHAT_UI, GATEWAY_CLIENT_MODES.WEBCHAT],
    ["Control UI", GATEWAY_CLIENT_IDS.CONTROL_UI, GATEWAY_CLIENT_MODES.UI],
    ["macOS app", GATEWAY_CLIENT_IDS.MACOS_APP, GATEWAY_CLIENT_MODES.UI],
    ["iOS app", GATEWAY_CLIENT_IDS.IOS_APP, GATEWAY_CLIENT_MODES.UI],
    ["Android app", GATEWAY_CLIENT_IDS.ANDROID_APP, GATEWAY_CLIENT_MODES.UI],
  ] as const)(
    "persists a configured %s voice transcript in its canonical user turn",
    async (_name, id, mode) => {
      const clientInfo = createClientInfo({ id, mode });
      mockPersistence();
      mockTranscript("transcribed voice");
      setRuntimeConfigSnapshot({});
      const { controller, readInput } = createUserTurnInputController();
      const scope = {
        default: "allow" as const,
        rules: [{ match: { channel: "webchat" }, action: "allow" as const }],
      };
      const prepared = prepareVoice(controller, {
        text: "raw message",
        clientInfo,
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
        attachments: {
          mediaPathOffloads: [
            {
              path: "/state/media/inbound/voice.ogg",
              contentType: "audio/ogg",
              fileName: "voice.ogg",
            },
          ],
          offloadedRefs: [voiceRef()],
        },
      });
      const input = await readInput();
      expect(input.text).toBe("raw message\nHeard: transcribed voice");
      const persisted = buildPersistedUserTurnMessage(input);
      expect(persisted.content).toBe("raw message\nHeard: transcribed voice");
      const target = createSqliteTranscriptTarget({ dir: tempDirs.make() });
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
    },
  );

  it("resolves transcript credentials and workspace from the selected agent", async () => {
    mockPersistence();
    let selectedPaths: { agentDir?: string; workspaceDir?: string } | undefined;
    transcribeAudioAttachments.mockImplementationOnce(async ({ ctx, agentDir, workspaceDir }) => {
      selectedPaths = { agentDir, workspaceDir };
      if (ctx.media?.[0]) {
        ctx.media[0] = { ...ctx.media[0], transcribed: true };
      }
      return "support transcript";
    });
    const { controller, readInput } = createUserTurnInputController("caption");
    const prepared = prepareVoice(controller, {
      agentId: "support",
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
      attachments: {
        mediaPathOffloads: [
          {
            path: "/state/media/inbound/support-voice.ogg",
            contentType: "audio/ogg",
            fileName: "support-voice.ogg",
          },
        ],
        offloadedRefs: [voiceRef("support-voice.ogg")],
      },
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
  });

  it("does not reintroduce a transcript removed by the approval hook", async () => {
    mockPersistence();
    mockTranscript("private transcript");
    const { controller, readInput } = createUserTurnInputController("caption");
    const prepared = prepareVoice(controller);

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
  });

  it.each(["none", "inline-image-save-failed"] as const)(
    "preserves approved caption and untrusted speech with media omission %s",
    async (omission) => {
      mockPersistence(omission);
      mockTranscript("approved transcript");
      const { controller, readInput } = createUserTurnInputController("a longer caption");
      const prepared = prepareVoice(controller, {
        text: "a longer caption",
        attachments: {
          imageOrder: ["inline"],
          parsedImages: [
            { type: "image", data: "aGVsbG8=", mimeType: "image/png", sourceIndex: 0 },
          ],
        },
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
    },
  );

  it.each(["", null, undefined])(
    "keeps transcript echo out of command parsing after approval with base text %s",
    async (baseText) => {
      mockPersistence();
      mockTranscript("/reset");
      const { controller, readInput } = createUserTurnInputController("");
      controller.baseInput.text = baseText;
      const prepared = prepareVoice(controller, {
        text: "",
        attachments: { offloadedRefs: [voiceRef()] },
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
    },
  );

  it("does not dispatch a raw slash command from a transcript-only echo", async () => {
    mockPersistence();
    mockTranscript("/reset");
    const { controller, readInput } = createUserTurnInputController("");
    const sessionEntry = { sessionId: "voice-session", updatedAt: 1 };
    const prepared = prepareVoice(controller, {
      text: "",
      cfg: {
        commands: { text: true },
        tools: { media: { audio: { echoTranscript: true, echoFormat: "{transcript}" } } },
      },
      attachments: { offloadedRefs: [voiceRef()] },
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
  });

  it("refuses a transcript when UI media admission expires during preflight", async () => {
    mockPersistence();
    const assertClientUploadAllowed = vi.fn(() => {
      if (assertClientUploadAllowed.mock.calls.length === 2) {
        throw new Error("admission expired");
      }
    });
    transcribeAudioAttachments.mockResolvedValueOnce("uncommitted voice");
    const { controller, readInput } = createUserTurnInputController("");
    const prepared = prepareVoice(controller, {
      text: "",
      cfg: { tools: { media: { audio: { echoTranscript: true } } } },
      attachments: { offloadedRefs: [voiceRef()] },
      assertClientUploadAllowed,
    });
    await expect(readInput()).rejects.toThrow("admission expired");
    expect(transcribeAudioAttachments).toHaveBeenCalledOnce();
    expect(prepared.ctx.Transcript).toBeUndefined();
    expect(assertClientUploadAllowed).toHaveBeenCalledTimes(2);
  });

  it("does not preflight voice attachments for non-chat clients", async () => {
    mockPersistence();
    transcribeAudioAttachments.mockResolvedValueOnce("must not run");
    const { controller, readInput } = createUserTurnInputController();
    prepareVoice(controller, {
      text: "",
      clientInfo: createClientInfo(),
      cfg: { tools: { media: { audio: { echoTranscript: true } } } },
      attachments: { parsedMessage: "hello" },
    });
    await expect(readInput()).resolves.toMatchObject({ text: "raw message" });
    expect(transcribeAudioAttachments).not.toHaveBeenCalled();
  });
});
