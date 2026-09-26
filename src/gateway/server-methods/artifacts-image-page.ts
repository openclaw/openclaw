import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  type ArtifactSummary,
  type ArtifactsListParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-accessor.sqlite-active-events.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { TranscriptReadWindow } from "../../sessions/transcript-read-window.js";
import { readSessionArtifacts } from "../session-transcript-readers.js";
import { ArtifactSessionResolutionError } from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

const CURSOR_TTL_MS = 15 * 60_000;
type ImageCursor = {
  binding: string;
  beforeSeq: number;
  imageOffset: number;
  readWindow: TranscriptReadWindow;
  expiresAt: number;
};

// Connection-owned continuation facts are bounded, ephemeral, and never confer access.
const cursors = new WeakMap<object, Map<string, ImageCursor>>();
const internalCaller = {};

export async function readArtifactImagePage(params: {
  scope: SessionTranscriptReadScope;
  binding: string;
  client: GatewayClient | null;
  cursor?: string;
  limit: number;
  sessionKey: string;
  filters: Pick<ArtifactsListParams, "runId" | "taskId" | "messageRole">;
}): Promise<{ artifacts: ArtifactSummary[]; nextCursor?: string; omittedOversized?: boolean }> {
  const owner = params.client ?? internalCaller;
  let state = cursors.get(owner);
  if (!state) {
    state = new Map();
    cursors.set(owner, state);
  }
  const now = Date.now();
  for (const [key, value] of state) {
    if (value.expiresAt <= now) {
      state.delete(key);
    }
  }
  const cursor = params.cursor ? state.get(params.cursor) : undefined;
  if (params.cursor && (!cursor || cursor.binding !== params.binding)) {
    throw new ArtifactSessionResolutionError(
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Image cursor expired or belongs to another session; restart artifacts.list",
        {
          details: { type: "artifact_cursor_invalid" },
        },
      ),
    );
  }
  const page = await readSessionArtifacts(params.scope, {
    kind: "image-page",
    sessionKey: params.sessionKey,
    ...params.filters,
    limit: params.limit,
    beforeSeq: cursor?.beforeSeq,
    imageOffset: cursor?.imageOffset,
    readWindow: cursor?.readWindow,
  }).catch((error: unknown) => {
    if (cursor && isSessionTranscriptProjectionUnavailableError(error)) {
      throw new ArtifactSessionResolutionError(
        errorShape(ErrorCodes.INVALID_REQUEST, "Transcript changed; restart artifacts.list", {
          details: { type: "artifact_cursor_invalid" },
        }),
      );
    }
    throw error;
  });
  let nextCursor: string | undefined;
  if (page.next) {
    nextCursor = randomUUID();
    state.set(nextCursor, {
      ...page.next,
      binding: params.binding,
      expiresAt: now + CURSOR_TTL_MS,
    });
    pruneMapToMaxSize(state, 128);
  }
  return {
    artifacts: page.artifacts,
    ...(nextCursor ? { nextCursor } : {}),
    ...(page.omittedOversized ? { omittedOversized: true } : {}),
  };
}
