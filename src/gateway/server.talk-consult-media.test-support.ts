// Shared Talk consult media boundary driver for the consult history suite.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { vi, type MockInstance } from "vitest";
import { createSolidPngBuffer } from "../../test/helpers/image-fixtures.js";
import {
  clearTestEmbeddedRun,
  createEmbeddedRunHandle,
  registerTestEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.test-support.js";
import type * as embeddedAgent from "../agents/embedded-agent.js";
import type { guardSessionManager } from "../agents/session-tool-result-guard-wrapper.js";
import { makeAgentAssistantMessage } from "../agents/test-helpers/agent-message-fixtures.js";
import { withGatewayToolCallerIdentity } from "../agents/tools/gateway-caller-context.js";
import { getRuntimeConfig } from "../config/config.js";
import { getCurrentSessionControllerOwner } from "../sessions/session-controller.lifecycle.js";
import type { RealtimeVoiceBridgeCreateRequest } from "../talk/provider-types.js";
import * as chatReplyMedia from "./server-methods/chat-reply-media.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { createTalkClientAgentConsultRunner } from "./talk/client-agent-consult.js";
import { createIdleRelayProvider, makeRelayTransport } from "./talk/relay/index.test-support.js";
import { createTalkRealtimeRelaySession } from "./talk/relay/session-create.js";
import { rememberUnifiedTalkSession } from "./talk/session-registry.js";
import { prepareTalkSessionTarget } from "./talk/session-target.js";

type RunEmbeddedAgent = typeof embeddedAgent.runEmbeddedAgent;

export type TalkConsultMediaFixture = {
  agentId: string;
  canonicalKey: string;
  sessionKey: string;
  voiceSessionId: string | undefined;
  context: GatewayRequestContext;
  connectionId: string;
  rpc: (method: string, params: Record<string, unknown>) => Promise<Record<string, unknown>>;
  runEmbeddedAgent: MockInstance<RunEmbeddedAgent>;
  args: { question: string };
  transcriptManager: (
    params: Parameters<RunEmbeddedAgent>[0],
  ) => ReturnType<typeof guardSessionManager>;
  waitForDispatchEnd: () => Promise<void>;
  drainPublications: () => Promise<void>;
  historyMessages: () => Promise<unknown[]>;
};

export type RelayConsultRunner = NonNullable<
  RealtimeVoiceBridgeCreateRequest["runAgentConsult"]
> & {
  adoptCompletionClaims: () => void;
  claimAppend: () => boolean;
  claimFailureAppend: () => boolean;
};
export type StagingControls = { closeCall: () => Promise<void>; relayRunner?: RelayConsultRunner };

export async function writeTestImage(
  dir: string,
  name = `talk-consult-189542-${randomUUID()}.png`,
) {
  const imagePath = path.join(dir, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(imagePath, createSolidPngBuffer(1, 1, { r: 24, g: 64, b: 128 }));
  return imagePath;
}

// Drives one consult through the production Talk callback into the real media owner.
// Fixture simplification: the fake model returns already-parsed mediaUrls, as the
// embedded runner does after stripping MEDIA directives from the reply text.
export async function runMediaConsult(
  fixture: TalkConsultMediaFixture,
  params: {
    route: "direct" | "relay";
    caption: string;
    mediaUrl: string;
    /** Files whose contents must not be opened unless delivery is authorized. */
    watchedFiles: string[];
    /** Runs inside media preparation, after admission and before any media read. */
    duringStaging?: (controls: StagingControls) => Promise<void>;
  },
) {
  const {
    agentId,
    canonicalKey,
    sessionKey,
    voiceSessionId,
    context,
    connectionId,
    rpc,
    runEmbeddedAgent,
    args,
    transcriptManager,
    waitForDispatchEnd,
    drainPublications,
    historyMessages,
  } = fixture;
  const watched = params.watchedFiles.map((file) => path.basename(file));
  const opened: string[] = [];
  const open = fs.open;
  const openSpy = vi.spyOn(fs, "open").mockImplementation((async (
    ...openArgs: Parameters<typeof fs.open>
  ) => {
    if (watched.some((name) => String(openArgs[0]).includes(name))) {
      opened.push(String(openArgs[0]));
    }
    return await open.apply(fs, openArgs);
  }) as typeof fs.open);
  let controls: StagingControls | undefined;
  const staging = params.duringStaging;
  const prepare = chatReplyMedia.prepareWebchatReplyMediaForDisplay;
  const gate = staging
    ? vi
        .spyOn(chatReplyMedia, "prepareWebchatReplyMediaForDisplay")
        .mockImplementation(async (input) => {
          await staging(expectDefined(controls, "staging controls"));
          return await prepare(input);
        })
    : undefined;
  const authored = params.caption
    ? `${params.caption}\nMEDIA:${params.mediaUrl}`
    : `MEDIA:${params.mediaUrl}`;
  runEmbeddedAgent.mockImplementation(async (run) => {
    await run.userTurnTranscriptRecorder?.persistApproved();
    // Register the backend as the real runner does, so the relay's completion claim promotes.
    const handle = createEmbeddedRunHandle({ runId: run.runId });
    await withGatewayToolCallerIdentity(
      {
        agentId,
        sessionKey: canonicalKey,
        operationalRunInstance: run.preparedRunAdmission?.operationalRunInstance,
      },
      () =>
        registerTestEmbeddedRun(
          run.sessionId,
          handle,
          run.sessionKey,
          undefined,
          run.agentId,
          expectDefined(getCurrentSessionControllerOwner(), "consult controller turn"),
        ),
    );
    try {
      transcriptManager(run).appendMessage(
        makeAgentAssistantMessage({ content: [{ type: "text", text: authored }] }),
      );
      return {
        payloads: [
          { ...(params.caption ? { text: params.caption } : {}), mediaUrls: [params.mediaUrl] },
        ],
        meta: { durationMs: 0 },
      };
    } finally {
      clearTestEmbeddedRun(run.sessionId, handle, run.sessionKey);
    }
  });
  const target = await prepareTalkSessionTarget(getRuntimeConfig(), sessionKey);
  let outcome: { text: string } | { error: string };
  let claimed: boolean | undefined;
  const settle = (run: Promise<{ text: string }>) =>
    run.then(
      ({ text }) => ({ text }),
      (error: unknown) => ({ error: error instanceof Error ? error.name : String(error) }),
    );
  try {
    if (params.route === "direct") {
      const callId = expectDefined(voiceSessionId, "direct voice session");
      controls = {
        closeCall: async () => {
          await rpc("talk.client.close", { sessionKey, voiceSessionId: callId });
        },
      };
      const runner = createTalkClientAgentConsultRunner({
        config: getRuntimeConfig(),
        context,
        sessionTarget: target,
        ownerConnId: connectionId,
        getVoiceSessionId: () => callId,
        initialItems: [],
      });
      outcome = await settle(runner.runArgs(args));
    } else {
      // The reported path: a GPT-Live relay adopts completion claims, then claims later.
      let request: RealtimeVoiceBridgeCreateRequest | undefined;
      const relay = createTalkRealtimeRelaySession({
        context,
        connId: connectionId,
        provider: createIdleRelayProvider((input) => {
          request = input;
          return makeRelayTransport();
        }),
        providerConfig: {},
        controlSource: "delegation",
        sessionTarget: target,
        instructions: "Test relay",
        tools: [],
      });
      rememberUnifiedTalkSession(relay.relaySessionId, {
        kind: "realtime-relay",
        connId: connectionId,
        relaySessionId: relay.relaySessionId,
        sessionTarget: target,
      });
      let closed = false;
      const closeRelay = async () => {
        if (!closed) {
          closed = true;
          await rpc("talk.session.close", { sessionId: relay.relaySessionId });
        }
      };
      try {
        // The relay runner carries its claim lifecycle beside the provider-facing callback.
        const runPrompt = expectDefined(
          request?.runAgentConsult,
          "relay consult runner",
        ) as RelayConsultRunner;
        controls = { closeCall: closeRelay, relayRunner: runPrompt };
        runPrompt.adoptCompletionClaims();
        outcome = await settle(runPrompt({ prompt: args.question }));
        claimed = runPrompt.claimAppend();
      } finally {
        await closeRelay();
      }
    }
  } finally {
    openSpy.mockRestore();
    gate?.mockRestore();
  }
  await waitForDispatchEnd();
  await drainPublications();
  const history = await historyMessages();
  const images = history.filter((message) =>
    JSON.stringify(asOptionalRecord(message)?.content).includes("/api/chat/media/outgoing/"),
  );
  return { outcome, claimed, opened, history, images };
}
