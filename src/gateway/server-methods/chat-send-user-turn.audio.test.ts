import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import * as chatAttachments from "../chat-attachments.js";
import { prepareVoice, requireInputText } from "./chat-send-user-turn-family.test-support.js";
import {
  createClientInfo,
  createUserTurnInputController,
} from "./chat-send-user-turn.test-support.js";

const { transcribeAudioAttachments } = vi.hoisted(() => ({ transcribeAudioAttachments: vi.fn() }));
vi.mock("../../media-understanding/audio-preflight.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../media-understanding/audio-preflight.js")>()),
  transcribeAudioAttachments,
}));

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
const echoAudio = {
  echoTranscript: true,
  echoFormat: "Heard: {transcript}",
  scope: { default: "allow" as const },
};
function expectCommandText(prepared: ReturnType<typeof prepareVoice>, text: string) {
  expect(prepared.ctx).toMatchObject({
    CommandBody: text,
    BodyForCommands: text,
    RawBody: text,
    CommandTurn: { body: text },
  });
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
function prepareTranscript(
  transcript: string,
  options?: Parameters<typeof prepareVoice>[0],
  omission?: Parameters<typeof mockPersistence>[0],
) {
  mockPersistence(omission);
  mockTranscript(transcript);
  return prepareVoice(options);
}

describe("prepareChatSendUserTurn audio", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    transcribeAudioAttachments.mockReset();
  });
  it.each([
    ["WebChat", GATEWAY_CLIENT_IDS.WEBCHAT_UI, GATEWAY_CLIENT_MODES.WEBCHAT],
    ["Control UI", GATEWAY_CLIENT_IDS.CONTROL_UI, GATEWAY_CLIENT_MODES.UI],
    ["macOS app", GATEWAY_CLIENT_IDS.MACOS_APP, GATEWAY_CLIENT_MODES.UI],
    ["iOS app", GATEWAY_CLIENT_IDS.IOS_APP, GATEWAY_CLIENT_MODES.UI],
    ["Android app", GATEWAY_CLIENT_IDS.ANDROID_APP, GATEWAY_CLIENT_MODES.UI],
  ] as const)(
    "prepares a configured %s voice transcript in its canonical user turn",
    async (_name, id, mode) => {
      const clientInfo = createClientInfo({ id, mode });
      const scope = {
        default: "allow" as const,
        rules: [{ match: { channel: "webchat" }, action: "allow" as const }],
      };
      const prepared = prepareTranscript("transcribed voice", {
        text: "raw message",
        clientInfo,
        agentId: "support",
        sessionKey: "agent:support:main",
        cfg: {
          agents: {
            entries: {
              main: { agentDir: "/state/agents/main", workspace: "/work/main" },
              support: { agentDir: "/state/agents/support", workspace: "/work/support" },
            },
          },
          tools: { media: { audio: { ...echoAudio, scope } } },
        },
        attachments: { offloadedRefs: [voiceRef()] },
      });
      const input = await prepared.readInput();
      expect(input.text).toBe("raw message\nHeard: transcribed voice");
      prepared.applyApprovedText(requireInputText(input));
      expect(prepared.ctx.Body).toBe("raw message\nHeard: transcribed voice");
      expect(prepared.ctx.BodyForAgent).toContain(
        '[Audio transcript (machine-generated, untrusted)]: "transcribed voice"',
      );
      expect(prepared.ctx.BodyForAgent).not.toContain("Heard: transcribed voice");

      expect(transcribeAudioAttachments).toHaveBeenCalledOnce();
      expect(transcribeAudioAttachments.mock.calls[0]?.[0]).toMatchObject({
        agentDir: "/state/agents/support",
        workspaceDir: "/work/support",
      });
      expect(prepared.ctx.AgentId).toBe("support");
      expect(
        transcribeAudioAttachments.mock.calls[0]?.[0].cfg.tools.media.audio.echoTranscript,
      ).toBe(false);
      expect(prepared.ctx.media?.[0]?.transcribed).toBe(true);
      expect(prepared.ctx.Transcript).toBe("transcribed voice");
      expect(prepared.ctx.agentText).toContain(
        '[Audio transcript (machine-generated, untrusted)]: "transcribed voice"',
      );
    },
  );

  it("does not reintroduce a transcript removed by the approval hook", async () => {
    const prepared = prepareTranscript("private transcript");

    await expect(prepared.readInput()).resolves.toMatchObject({
      text: "caption\nHeard: private transcript",
    });
    prepared.applyApprovedText("caption");
    expect(prepared.ctx.BodyForAgent).toBe("caption");
    expect(prepared.ctx.Transcript).toBeUndefined();

    prepared.applyApprovedText("caption\nHeard: [redacted]");
    expect(prepared.ctx.BodyForAgent).toBe("caption\nHeard: [redacted]");
    expect(prepared.ctx.Transcript).toBeUndefined();
  });

  it.each(["none", "inline-image-save-failed"] as const)(
    "preserves approved caption and untrusted speech with media omission %s",
    async (omission) => {
      const prepared = prepareTranscript(
        "approved transcript",
        {
          text: "a longer caption",
          attachments: {
            imageOrder: ["inline"],
            parsedImages: [
              { type: "image", data: "aGVsbG8=", mimeType: "image/png", sourceIndex: 0 },
            ],
          },
        },
        omission,
      );

      const input = await prepared.readInput();
      expect(prepared.replyOptionImages).toEqual([
        { type: "image", data: "aGVsbG8=", mimeType: "image/png", sourceIndex: 0 },
      ]);
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
      expectCommandText(prepared, "x");
    },
  );

  it.each([
    ["", "Heard: {transcript}", "Heard: /reset"],
    [null, "Heard: {transcript}", "Heard: /reset"],
    [undefined, "Heard: {transcript}", "Heard: /reset"],
    ["", "{transcript}", "/reset"],
  ] as const)(
    "keeps transcript echo out of command input with base text %s and format %s",
    async (baseText, echoFormat, echo) => {
      const inputController = createUserTurnInputController("");
      inputController.controller.baseInput.text = baseText;
      const prepared = prepareTranscript("/reset", {
        input: inputController,
        text: "",
        cfg: {
          commands: { text: true },
          tools: { media: { audio: { echoTranscript: true, echoFormat } } },
        },
        attachments: { offloadedRefs: [voiceRef()] },
      });
      const input = await prepared.readInput();
      expect(input.text).toBe(echo);
      prepared.applyApprovedText(requireInputText(input));
      expect(prepared.ctx.Body).toBe(echo);
      expect(prepared.ctx.BodyForAgent).toBe(
        '[Audio transcript (machine-generated, untrusted)]: "/reset"',
      );
      expect(prepared.ctx.CommandTurn).toMatchObject({ kind: "normal", body: "" });
      expectCommandText(prepared, "");
      expect(prepared.ctx.CommandSource).toBeUndefined();
      expect(prepared.isInternalTextSlashCommandTurn).toBe(false);
      expect(prepared.ctx.media?.[0]?.transcribed).toBe(true);
    },
  );

  it("refuses a transcript when UI media admission expires during preflight", async () => {
    mockPersistence();
    const assertClientUploadAllowed = vi.fn(() => {
      if (assertClientUploadAllowed.mock.calls.length === 2) {
        throw new Error("admission expired");
      }
    });
    transcribeAudioAttachments.mockResolvedValueOnce("uncommitted voice");
    const prepared = prepareVoice({
      text: "",
      cfg: { tools: { media: { audio: { echoTranscript: true } } } },
      attachments: { offloadedRefs: [voiceRef()] },
      assertClientUploadAllowed,
    });
    await expect(prepared.readInput()).rejects.toThrow("admission expired");
    expect(transcribeAudioAttachments).toHaveBeenCalledOnce();
    expect(prepared.ctx.Transcript).toBeUndefined();
    expect(assertClientUploadAllowed).toHaveBeenCalledTimes(2);
  });

  it("does not preflight voice attachments for non-chat clients", async () => {
    mockPersistence();
    transcribeAudioAttachments.mockResolvedValueOnce("must not run");
    const prepared = prepareVoice({
      input: createUserTurnInputController(),
      text: "",
      clientInfo: createClientInfo(),
      cfg: { tools: { media: { audio: { echoTranscript: true } } } },
      attachments: { parsedMessage: "hello" },
    });
    await expect(prepared.readInput()).resolves.toMatchObject({ text: "raw message" });
    expect(transcribeAudioAttachments).not.toHaveBeenCalled();
  });
});
