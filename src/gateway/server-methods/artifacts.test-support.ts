import { expect, vi } from "vitest";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { selectSessionArtifacts } from "../session-artifact-read.js";
import type { prepareSessionMutationFacts } from "../session-sharing-preparation.js";
import { resolveSessionStoreIdentity } from "../session-store-key.js";
import type { SessionTranscriptVisitor } from "../session-transcript-read.types.js";
import { expectRecordFields } from "../test-helpers.assertions.js";
import type { GatewayRequestHandler, GatewayRequestHandlerOptions, RespondFn } from "./types.js";

type ResponderCalls = Array<{ ok: boolean; payload?: unknown; error?: unknown }>;
type ArtifactListPayload = { artifacts?: Array<Record<string, unknown>> };

export async function invokeArtifact(
  method: "artifacts.list" | "artifacts.get" | "artifacts.download",
  params: Record<string, unknown>,
  options: Pick<GatewayRequestHandlerOptions, "context" | "client"> &
    Partial<
      Pick<GatewayRequestHandlerOptions, "signal" | "hasCurrentClientAuthority" | "respond">
    > & {
      id?: string;
      dispatch?: GatewayRequestHandler;
    },
) {
  const { id = method, dispatch, respond: record, ...rest } = options;
  const respond = vi.fn<RespondFn>(record);
  const handle = dispatch ?? (await import("./artifacts.js")).artifactsHandlers[method]!;
  await handle({
    ...rest,
    params,
    respond,
    isWebchatConnect: () => false,
    req: { type: "req", id, method, params },
  });
  return respond;
}

export function artifactSession(sessionId: string, owner = "owner") {
  return {
    scope: { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}` },
    entry: {
      sessionId,
      updatedAt: 1,
      visibility: "shared" as const,
      createdActor: { type: "human" as const, source: "profile" as const, id: owner },
    },
  };
}

export async function writeArtifactTranscript(
  scope: { agentId: string; sessionKey: string; sessionId: string; storePath?: string },
  content: unknown[],
  id = "artifact",
) {
  const { replaceTranscriptEvents } =
    await import("../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js");
  const { waitForSessionTranscriptProjection } =
    await import("../../config/sessions/session-accessor.js");
  await replaceTranscriptEvents(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    { type: "message", id, parentId: null, message: { role: "assistant", content } },
  ]);
  await waitForSessionTranscriptProjection(scope);
}

/** Transcript-format fixtures; access and lifetime suites retain the real facts owner. */
export function artifactFixtureSessionFacts(
  params: Parameters<typeof prepareSessionMutationFacts>[0],
) {
  const { agentId, canonicalKey } = resolveSessionStoreIdentity(params);
  const storageTarget = { agentId, canonicalKey, storePath: "/tmp/sessions.json" };
  return {
    storageTarget,
    bindCreation() {},
    release() {},
    readCurrent: () => ({
      target: {
        ...storageTarget,
        storeKey: canonicalKey,
        storeKeys: [canonicalKey],
        entry: { sessionId: "sess-main" },
      },
      membership: new Set<string>(),
      sourceAgentId: agentId,
      sourcePath: storageTarget.storePath,
    }),
  };
}

export function withArtifactFixtureReader(
  actual: typeof import("../session-transcript-readers.js"),
  visitSessionMessagesAsync: SessionTranscriptVisitor["visitSessionMessagesAsync"],
) {
  return {
    ...actual,
    readSessionArtifacts: (
      scope: Parameters<typeof selectSessionArtifacts>[0],
      query: Parameters<typeof selectSessionArtifacts>[1],
    ) =>
      selectSessionArtifacts(scope, query, {
        visitSessionMessagesAsync,
        readSessionMessagesPageWithStatsAsync: actual.readSessionMessagesPageWithStatsAsync,
      }),
  };
}

export function runtimeContext(config: OpenClawConfig) {
  setRuntimeConfigSnapshot(config);
  return { getRuntimeConfig: () => config };
}

export function expectOkPayload(calls: ResponderCalls): unknown {
  expect(calls[0]?.ok).toBe(true);
  return calls[0]?.payload;
}

export function expectArtifactList(calls: ResponderCalls): ArtifactListPayload {
  return expectOkPayload(calls) as ArtifactListPayload;
}

export function expectErrorDetails(calls: ResponderCalls): Record<string, unknown> | undefined {
  expect(calls[0]?.ok).toBe(false);
  return calls[0] ? (calls[0].error as { details?: Record<string, unknown> }).details : undefined;
}

export function assistantFileMessage({
  data = "aGVsbG8=",
  title,
  seq = 2,
  runId,
}: {
  data?: string;
  title: string;
  seq?: number;
  runId?: string;
}) {
  return {
    role: "assistant",
    content: [{ type: "file", data, mimeType: "text/plain", title }],
    __openclaw: { seq, ...(runId ? { runId } : {}) },
  };
}

export function resultImageMessage() {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "see attached" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png", alt: "result.png" },
    ],
    __openclaw: { seq: 2 },
  };
}

export function requireNonEmptyString(value: unknown, message: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(message);
  }
  return value;
}

export function expectFields(value: unknown, expected: Record<string, unknown>): void {
  expectRecordFields(value, "fields", expected);
}
