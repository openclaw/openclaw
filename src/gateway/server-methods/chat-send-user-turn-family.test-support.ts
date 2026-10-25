import { vi } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { prepareChatSendUserTurn } from "./chat-send-user-turn.js";
import {
  createAttachments,
  createClientInfo,
  createUserTurnInputController,
} from "./chat-send-user-turn.test-support.js";

type TurnParams = Parameters<typeof prepareChatSendUserTurn>[0];
type TurnOptions = Partial<
  Pick<TurnParams, "client" | "logGateway" | "admission" | "assertInputCurrent">
> & {
  attachments?: Partial<TurnParams["attachments"]>;
  request?: Partial<TurnParams["request"]>;
  session?: Partial<TurnParams["session"]>;
  inputText?: string;
  input?: ReturnType<typeof createUserTurnInputController>;
};

export function prepareTurn({
  request,
  session,
  admission,
  attachments,
  inputText = "raw message",
  input = createUserTurnInputController(inputText),
  ...overrides
}: TurnOptions = {}) {
  return {
    ...prepareChatSendUserTurn({
      request: {
        inboundMessage: "hello",
        clientInfo: createClientInfo(),
        suppressCommandInterpretation: false,
        systemInputProvenance: undefined,
        systemProvenanceReceipt: undefined,
        ...request,
      },
      session: { agentId: "main", clientRunId: "run-1", sessionKey: "agent:main:main", ...session },
      admission: admission ?? {
        originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
      },
      attachments: createAttachments(attachments),
      userTurn: input.controller,
      client: null,
      logGateway: { warn: vi.fn() } as never,
      ...overrides,
    }),
    readInput: input.readInput,
    baseInput: input.controller.baseInput,
  };
}

export function prepareVoice({
  text = "caption",
  clientInfo = createClientInfo({
    id: GATEWAY_CLIENT_IDS.WEBCHAT_UI,
    mode: GATEWAY_CLIENT_MODES.WEBCHAT,
  }),
  agentId = "main",
  sessionKey = "agent:main:main",
  clientRunId = "run-voice",
  cfg = {
    tools: { media: { audio: { echoTranscript: true, echoFormat: "Heard: {transcript}" } } },
  },
  attachments,
  assertClientUploadAllowed,
  assertInputCurrent,
  input,
}: {
  text?: string;
  clientInfo?: TurnParams["request"]["clientInfo"];
  agentId?: string;
  sessionKey?: string;
  clientRunId?: string;
  cfg?: TurnParams["session"]["cfg"];
  attachments?: Partial<TurnParams["attachments"]>;
  assertClientUploadAllowed?: TurnParams["admission"]["assertClientUploadAllowed"];
  assertInputCurrent?: TurnParams["assertInputCurrent"];
  input?: TurnOptions["input"];
} = {}) {
  return prepareTurn({
    inputText: text,
    input,
    request: { inboundMessage: text, clientInfo },
    session: { agentId, clientRunId, sessionKey, cfg },
    admission: {
      originatingRoute: { originatingChannel: "webchat", explicitDeliverRoute: false },
      assertClientUploadAllowed,
    },
    attachments: {
      parsedMessage: text,
      mediaPathOffloads: [{ path: "/state/media/inbound/voice.ogg", contentType: "audio/ogg" }],
      ...attachments,
    },
    assertInputCurrent,
  });
}

export function requireInputText(input: { text?: string | null }): string {
  if (typeof input.text !== "string") {
    throw new Error("Expected prepared user-turn text");
  }
  return input.text;
}
