import { randomUUID } from "node:crypto";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  ErrorCodes,
  errorShape,
  type ArtifactSummary,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionTranscriptReadScope } from "../../config/sessions/session-accessor.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-accessor.sqlite-active-events.js";
import type { TranscriptReadWindow } from "../../sessions/transcript-read-window.js";
import { readSessionMessagesPageWithStatsAsync } from "../session-transcript-readers.js";
import { ArtifactSessionResolutionError } from "./artifacts-session-resolution.js";
import type { GatewayClient } from "./types.js";

const IMAGE_PAGE_MESSAGES = 32;
const IMAGE_PAGE_BYTES = 256 * 1024;
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
  collect: (message: unknown) => ArtifactSummary[];
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
  const page = await readSessionMessagesPageWithStatsAsync(params.scope, {
    offset: 0,
    beforeSeq: cursor?.beforeSeq,
    maxMessages: IMAGE_PAGE_MESSAGES,
    maxBytes: IMAGE_PAGE_BYTES,
    readOnly: true,
    captureReadWindow: true,
    expectedReadWindow: cursor?.readWindow,
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
  const artifacts: ArtifactSummary[] = [];
  let next: Pick<ImageCursor, "beforeSeq" | "imageOffset"> | undefined;
  for (const message of page.messages.toReversed()) {
    const seq = asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.seq;
    if (typeof seq !== "number") {
      continue;
    }
    const images = params.collect(message);
    const start = cursor?.beforeSeq === seq + 1 ? cursor.imageOffset : 0;
    for (let index = start; index < images.length; index++) {
      const image = images[index];
      if (image) {
        artifacts.push(image);
      }
      if (artifacts.length === params.limit) {
        next =
          index + 1 < images.length
            ? { beforeSeq: seq + 1, imageOffset: index + 1 }
            : seq > 1
              ? { beforeSeq: seq, imageOffset: 0 }
              : undefined;
        break;
      }
    }
    if (artifacts.length === params.limit) {
      break;
    }
  }
  if (artifacts.length < params.limit && page.olderOffset !== undefined) {
    const head = cursor?.beforeSeq ?? page.totalMessages + 1;
    next = { beforeSeq: head - page.olderOffset, imageOffset: 0 };
  }
  let nextCursor: string | undefined;
  if (next && next.beforeSeq > 1 && page.readWindow) {
    nextCursor = randomUUID();
    state.set(nextCursor, {
      ...next,
      binding: params.binding,
      readWindow: page.readWindow,
      expiresAt: now + CURSOR_TTL_MS,
    });
    while (state.size > 128) {
      const oldest = state.keys().next().value;
      if (oldest) {
        state.delete(oldest);
      }
    }
  }
  return {
    artifacts,
    ...(nextCursor ? { nextCursor } : {}),
    ...(page.omittedOversized ? { omittedOversized: true } : {}),
  };
}
