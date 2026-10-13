import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey } from "../routing/session-key.js";
import type { GatewayBroadcastOpts } from "./server-broadcast-types.js";
import { resolveSessionEventAgentScope } from "./session-request-agent.js";
import type { SessionRowProjection } from "./session-row-projection.js";

/** Bind content to the resident publication before notification preparation can yield. */
export function captureWebPushAnswerPreviewAuthority(params: {
  event: string;
  payload: unknown;
  opts?: GatewayBroadcastOpts;
  getConfig: () => OpenClawConfig;
  getProjection: () => SessionRowProjection | undefined;
}): GatewayBroadcastOpts["answerPreview"] {
  const { payload, opts } = params;
  if (
    params.event !== "chat" ||
    !isRecord(payload) ||
    payload.state !== "final" ||
    typeof payload.sessionKey !== "string" ||
    opts?.sessionKeys?.length !== 1 ||
    opts.sessionKeys[0] !== payload.sessionKey ||
    isIncognitoSessionKey(payload.sessionKey)
  ) {
    return undefined;
  }
  try {
    const scope = resolveSessionEventAgentScope(
      params.getConfig(),
      payload.sessionKey,
      opts.agentId ?? (typeof payload.agentId === "string" ? payload.agentId : undefined),
    );
    const projection = params.getProjection();
    if (!projection || !scope?.[1]) {
      return undefined;
    }
    const query = { key: payload.sessionKey, agentId: scope[1] };
    const captured = projection.capture(query);
    const target = projection.sharingTarget(query);
    const source = captured?.publishedSource;
    if (
      !captured ||
      !target ||
      !projection.isCurrent(captured) ||
      target.generation !== captured.generation ||
      target.canonicalKey !== payload.sessionKey ||
      !target.entry.sessionId ||
      !target.entry.lifecycleRevision ||
      target.entry.incognito ||
      typeof source?.identity !== "string"
    ) {
      return undefined;
    }
    // Projection and sharing readers use different logical store paths; bind
    // their common physical source identity instead.
    const original = {
      sessionId: target.entry.sessionId,
      lifecycleRevision: target.entry.lifecycleRevision,
      sourcePath: source.filename,
      sourceIdentity: source.identity,
      sourceBirthtime: source.birthtime,
    };
    return {
      payload,
      text: opts.answerPreviewText,
      canPreview(current) {
        try {
          const resident = projection.sharingTarget(query);
          return (
            params.getProjection() === projection &&
            projection.isCurrent(captured) &&
            resident?.generation === captured.generation &&
            current?.agentId === target.agentId &&
            current.canonicalKey === target.canonicalKey &&
            current.entry.sessionId === original.sessionId &&
            current.entry.lifecycleRevision === original.lifecycleRevision &&
            !current.entry.incognito &&
            current.readSource?.path === original.sourcePath &&
            current.readSource.databaseIdentity === original.sourceIdentity &&
            current.readSource.databaseBirthtime === original.sourceBirthtime
          );
        } catch {
          return false;
        }
      },
    };
  } catch {
    return undefined;
  }
}
