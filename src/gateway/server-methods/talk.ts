import type { GatewayRequestHandlers } from "./types.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { redactConfigObject } from "../../config/redact-snapshot.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateTalkConfigParams,
  validateTalkModeParams,
} from "../protocol/index.js";

const ADMIN_SCOPE = "operator.admin";
const TALK_SECRETS_SCOPE = "operator.talk.secrets";

function canReadTalkSecrets(client: { connect?: { scopes?: string[] } } | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE) || scopes.includes(TALK_SECRETS_SCOPE);
}

function normalizeTalkConfigSection(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const source = value as Record<string, unknown>;
  const talk: Record<string, unknown> = {};
  if (typeof source.voiceId === "string") {
    talk.voiceId = source.voiceId;
  }
  if (
    source.voiceAliases &&
    typeof source.voiceAliases === "object" &&
    !Array.isArray(source.voiceAliases)
  ) {
    const aliases: Record<string, string> = {};
    for (const [alias, id] of Object.entries(source.voiceAliases as Record<string, unknown>)) {
      if (typeof id !== "string") {
        continue;
      }
      aliases[alias] = id;
    }
    if (Object.keys(aliases).length > 0) {
      talk.voiceAliases = aliases;
    }
  }
  if (typeof source.modelId === "string") {
    talk.modelId = source.modelId;
  }
  if (typeof source.outputFormat === "string") {
    talk.outputFormat = source.outputFormat;
  }
  if (typeof source.apiKey === "string") {
    talk.apiKey = source.apiKey;
  }
  if (typeof source.interruptOnSpeech === "boolean") {
    talk.interruptOnSpeech = source.interruptOnSpeech;
  }
  return Object.keys(talk).length > 0 ? talk : undefined;
}

export const talkHandlers: GatewayRequestHandlers = {
  "talk.config": async ({ params, respond, client }) => {
    if (!validateTalkConfigParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.config params: ${formatValidationErrors(validateTalkConfigParams.errors)}`,
        ),
      );
      return;
    }

    const includeSecrets = Boolean((params as { includeSecrets?: boolean }).includeSecrets);
    if (includeSecrets && !canReadTalkSecrets(client)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${TALK_SECRETS_SCOPE}`),
      );
      return;
    }

    const snapshot = await readConfigFileSnapshot();
    const configPayload: Record<string, unknown> = {};

    const talkSource = includeSecrets
      ? snapshot.config.talk
      : redactConfigObject(snapshot.config.talk);
    const talk = normalizeTalkConfigSection(talkSource);
    if (talk) {
      configPayload.talk = talk;
    }

    const sessionMainKey = snapshot.config.session?.mainKey;
    if (typeof sessionMainKey === "string") {
      configPayload.session = { mainKey: sessionMainKey };
    }

    const seamColor = snapshot.config.ui?.seamColor;
    if (typeof seamColor === "string") {
      configPayload.ui = { seamColor };
    }

    respond(true, { config: configPayload }, undefined);
  },
  "talk.mode": ({ params, respond, context, client, isWebchatConnect }) => {
    if (client && isWebchatConnect(client.connect) && !context.hasConnectedMobileNode()) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "talk disabled: no connected iOS/Android nodes"),
      );
      return;
    }
    if (!validateTalkModeParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid talk.mode params: ${formatValidationErrors(validateTalkModeParams.errors)}`,
        ),
      );
      return;
    }
    const payload = {
      enabled: (params as { enabled: boolean }).enabled,
      phase: (params as { phase?: string }).phase ?? null,
      ts: Date.now(),
    };
    context.broadcast("talk.mode", payload, { dropIfSlow: true });
    respond(true, payload, undefined);
  },
};
