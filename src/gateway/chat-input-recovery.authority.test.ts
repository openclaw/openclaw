// Load the real Gateway/model runtime during collection, outside the proof deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { rawDataToString } from "../../packages/gateway-client/src/websocket-data.js";
import { WebSocket } from "../../packages/gateway-client/src/websocket.js";
import type { ResponseFrame } from "../../packages/gateway-protocol/src/schema/frames.js";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import {
  acquireGatewayTestWebSocket,
  closeGatewayTestWebSocket,
} from "../../test/helpers/gateway-websocket.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { stripInternalRuntimeContext } from "../agents/internal-runtime-context.js";
import { captureRequesterOrigin } from "../agents/requester-origin.js";
import { ensureAgentWorkspace } from "../agents/workspace.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  listSessionParticipantsReadOnly,
  replaceSessionEntry,
} from "../config/sessions/session-accessor.js";
import { stageSessionPendingInput } from "../config/sessions/session-accessor.pending-inputs.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { addSessionMember, removeSessionMember } from "../config/sessions/session-sharing-store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { loadOrCreateDeviceIdentityAsync } from "../infra/device-identity-async.js";
import { persistDevicePairingStoreState } from "../infra/device-pairing-store.js";
import { waitForSessionParticipantRecording } from "../sessions/session-participant-recording.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import {
  closeProvider,
  listenProvider,
  readProviderBody,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import { createOperatorRecoveryFixture } from "./operator-run-recovery.test-support.js";
import {
  createChatInputRecovery,
  normalizeChatSendRequest,
} from "./server-methods/chat-send-request.js";
import { createContext } from "./server-plugin-in-process-dispatch.test-support.js";
import * as deliveryRecovery from "./session-send-recovery.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { KERNEL_TEST_ENV } from "./test-helpers.env.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

type PendingInput = Parameters<typeof stageSessionPendingInput>[1];
async function interruptInput(
  target: Parameters<typeof stageSessionPendingInput>[0],
  runId: string,
  content: string,
  fields: Pick<PendingInput["message"], "provenance" | "__openclaw">,
  requestFingerprint?: PendingInput["requestFingerprint"],
) {
  const receipt = expectDefined(
    await stageSessionPendingInput(target, {
      runId,
      requestFingerprint,
      message: {
        role: "user",
        content,
        timestamp: Date.now(),
        idempotencyKey: `${runId}:user`,
        ...fields,
      },
      assertCurrent() {},
    }),
    "accepted pending input",
  );
  receipt.finish("interrupted");
  await receipt.settled?.();
}

it.for(["steer", "followup"] as const)(
  "rechecks captured chat operators and resumes their predecessor before %s replay",
  { timeout: 90_000 },
  async (queueMode) => {
    const runPrefix = `replay-${queueMode}`;
    const state = await createOpenClawTestState({
      label: "chat-replay-authority",
      env: {
        ...KERNEL_TEST_ENV,
        OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
      },
    });
    const effectsPath = path.join(state.workspaceDir, "replayed.txt");
    const requests: string[] = [];
    const replayOrder: string[] = [];
    const startedRuns: string[] = [];
    const stopObserving = onAgentEvent((event) => {
      if (event.stream === "lifecycle" && event.data.phase === "start") {
        startedRuns.push(event.runId);
      }
    });
    const providerErrors: unknown[] = [];
    const reply = (response: Parameters<typeof writeOpenAiResponsesText>[0], text: string) =>
      writeOpenAiResponsesText(response, {
        text,
        messageId: randomUUID(),
        responseId: randomUUID(),
      });
    const providerServer = createServer((request, response) => {
      void (async () => {
        if (request.method !== "POST") {
          response.writeHead(200).end('{"data":[]}');
          return;
        }
        const body = await readProviderBody(request);
        const payload = JSON.parse(body) as {
          input: Array<{
            type?: string;
            role?: string;
            content?: string | Array<{ text?: string }>;
          }>;
        };
        // Historical interrupted-input notices may quote future queued messages.
        const activeInput = payload.input
          .filter((item) => item.role === "user")
          .map((item) =>
            stripInternalRuntimeContext(
              typeof item.content === "string"
                ? item.content
                : (item.content ?? []).map((part) => part.text ?? "").join("\n"),
            ),
          )
          .findLast((text) => text.trim());
        if (activeInput?.includes("PEER_INPUT")) {
          replayOrder.push("peer");
          reply(response, "Peer completed.");
          return;
        }
        if (activeInput?.includes("PREDECESSOR_INPUT")) {
          replayOrder.push("predecessor");
          reply(response, "Predecessor completed.");
          return;
        }
        replayOrder.push("chat");
        requests.push(body);
        if (payload.input.some((item) => item.type === "function_call_output")) {
          reply(response, "Replay completed.");
        } else {
          writeToolCall(response, "write", { path: effectsPath, content: "UNCHANGED_OPERATOR" });
        }
      })().catch((error: unknown) => {
        providerErrors.push(error);
        response.writeHead(500).end();
      });
    });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let startupProbe: WebSocket | undefined;
    const recoveryStarted = createDeferred();
    const releaseRecovery = createDeferred();
    const recover = deliveryRecovery.recoverSessionSendDeliveries;
    const recoverySpy = vi
      .spyOn(deliveryRecovery, "recoverSessionSendDeliveries")
      .mockImplementation(async (...args) => {
        recoveryStarted.resolve();
        await releaseRecovery.promise;
        return recover(...args);
      });
    try {
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(providerServer),
        "chat-replay-authority",
      );
      const config: OpenClawConfig = {
        agents: {
          ownership: "explicit",
          entries: { main: {} },
          defaults: {
            workspace: state.workspaceDir,
            skipBootstrap: false,
            heartbeat: { every: "0m" },
            model: { primary: provider.modelRef },
            models: { [provider.modelRef]: { agentRuntime: { id: "openclaw" } } },
          },
        },
        models: {
          mode: "replace",
          providers: {
            [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
          },
        },
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: { allow: ["write"] },
        gateway: {
          auth: { mode: "token", token: "synthetic-replay-token" },
          roles: {
            default: "writer",
            definitions: {
              writer: {
                agents: "*",
                sessions: { others: "none" },
                scopes: ["operator.read", "operator.write"],
              },
              revoked: { agents: [], sessions: { others: "none" }, scopes: ["operator.read"] },
            },
          },
        },
      };
      await state.writeConfig(config);
      setRuntimeConfigSnapshot(config);
      await ensureAgentWorkspace({ dir: state.workspaceDir, ensureBootstrapFiles: true });
      await loadOrCreateDeviceIdentityAsync();
      const cases = [];
      const owner = ensureProfileForEmail("owner@example.test");
      const device = {
        deviceId: "revoked-replay-device",
        publicKey: "synthetic-public-key",
        roles: ["operator"],
        approvedScopes: ["operator.read", "operator.write"],
        tokens: {
          operator: {
            token: "synthetic-device-token",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
            createdAtMs: 1,
          },
        },
        createdAtMs: 1,
        approvedAtMs: 1,
      } satisfies Parameters<typeof createOperatorRecoveryFixture>[0]["device"];
      for (const change of ["unchanged", "role", "device", "membership"] as const) {
        const profile = ensureProfileForEmail(`${change}@example.test`);
        if (change === "unchanged") {
          const personalDir = path.join(state.workspaceDir, "users", profile.id);
          await fs.mkdir(personalDir, { recursive: true });
          await fs.writeFile(path.join(personalDir, "USER.md"), "RECOVERED_PERSONAL_PREFERENCES");
        }
        const sessionKey = `agent:main:${runPrefix}-${change}`;
        const sessionId = `${runPrefix}-${change}`;
        if (change === "membership") {
          // Creator attribution is immutable; seed the other owner before capture.
          await replaceSessionEntry(
            { agentId: "main", sessionKey },
            {
              sessionId,
              updatedAt: Date.now(),
              createdActor: { type: "human", source: "profile", id: owner.id },
            },
          );
        }
        const fixture = await createOperatorRecoveryFixture({
          stateDir: state.stateDir,
          context: createContext(),
          config,
          profileId: profile.id,
          scopes: ["operator.read", "operator.write"],
          sourceIngress: "control-ui",
          sessionKey,
          sessionId,
          sourceRunId: `${runPrefix}-${change}`,
          device: change === "device" ? device : undefined,
        });
        const normalized = await normalizeChatSendRequest({
          client: fixture.client,
          params: {
            sessionKey: fixture.target.sessionKey,
            idempotencyKey: fixture.target.sourceRunId,
            message: `REPLAY_${change.toUpperCase()}`,
            ...(change === "unchanged" ? { queueMode } : {}),
            deliver: false,
          },
        });
        if (!normalized.ok) {
          throw new Error(normalized.error);
        }
        const recovery = expectDefined(
          createChatInputRecovery({
            request: normalized.value,
            source: fixture.entry.restartRecoveryOperatorSource,
          }),
          "captured chat authority",
        );
        if (change === "unchanged") {
          await appendTranscriptMessage(fixture.target, {
            message: { role: "user", content: "PREDECESSOR_INPUT", timestamp: Date.now() },
          });
          await replaceSessionEntry(fixture.target, {
            ...fixture.entry,
            status: "interrupted",
            abortedLastRun: true,
            restartRecoveryDeliveryRunId: `${runPrefix}-recovery-predecessor`,
            restartRecoveryDeliverySourceRunId: `${runPrefix}-predecessor`,
            restartRecoveryOperatorSource: {
              ...expectDefined(fixture.entry.restartRecoveryOperatorSource, "predecessor operator"),
              sourceRunId: `${runPrefix}-predecessor`,
            },
          });
          const source = {
            agentId: "main",
            sessionKey: `agent:main:${runPrefix}-peer-source`,
            sessionId: `${runPrefix}-peer-source`,
            lifecycleRevision: `${runPrefix}-peer-source`,
          };
          await replaceSessionEntry(source, {
            sessionId: source.sessionId,
            lifecycleRevision: source.lifecycleRevision,
            updatedAt: Date.now(),
            createdActor: { type: "human", source: "profile", id: profile.id },
          });
          const peerRunId = `${runPrefix}-peer`;
          await interruptInput(fixture.target, peerRunId, "PEER_INPUT", {
            provenance: {
              kind: "inter_session",
              sourceTool: "sessions_send",
              sourceSessionKey: source.sessionKey,
            },
            __openclaw: {
              requesterOrigin: captureRequesterOrigin({
                sessionKey: source.sessionKey,
                operatorProfileId: profile.id,
              }),
              sessionSendDelivery: {
                version: 1,
                runId: peerRunId,
                source,
                target: {
                  agentId: "main",
                  sessionKey: fixture.target.sessionKey,
                  sessionId: fixture.target.sessionId,
                  lifecycleRevision: fixture.entry.lifecycleRevision,
                },
                sandboxed: false,
                message: "PEER_INPUT",
                operatorSource: { kind: "gateway", snapshot: recovery.source.snapshot },
              },
            },
          });
        } else {
          await replaceSessionEntry(fixture.target, {
            sessionId: fixture.entry.sessionId,
            updatedAt: fixture.entry.updatedAt,
            lifecycleRevision: fixture.entry.lifecycleRevision,
            createdActor: fixture.entry.createdActor,
            ...(change === "membership" ? { visibility: "read-only" } : {}),
          });
        }
        if (change === "membership") {
          await addSessionMember(fixture.target, {
            identityId: profile.id,
            addedBy: owner.id,
          });
        }
        await interruptInput(
          fixture.target,
          fixture.target.sourceRunId,
          `REPLAY_${change.toUpperCase()}`,
          {
            __openclaw: {
              chatInputRecovery: recovery,
              chatRequestIdentity: normalized.value.requestIdentity,
            },
          },
          normalized.value.requestIdentity,
        );
        cases.push({ change, fixture });
        if (change === "role") {
          setUserProfileRole(profile.id, "revoked");
        }
        if (change === "device") {
          persistDevicePairingStoreState(
            { pendingById: {}, pairedByDeviceId: {} },
            state.stateDir,
            "both",
          );
        }
        if (change === "membership") {
          await removeSessionMember(fixture.target, profile.id);
        }
      }
      gateway = await startGatewayWithClient({
        cfg: config,
        configPath: state.configPath,
        token: "synthetic-replay-token",
      });
      const client = gateway.client;
      const expectRunOk = async (runId: string) => {
        await expect(
          client.request("agent.wait", { runId, timeoutMs: 30_000 }),
        ).resolves.toMatchObject({ status: "ok" });
      };
      await gateway.server.startupSettled;
      await recoveryStarted.promise;
      const successor = {
        sessionKey: `agent:main:${runPrefix}-unchanged`,
        message: "SUCCESSOR_MUST_WAIT",
        idempotencyKey: `${runPrefix}-successor`,
        deliver: false,
      };
      try {
        // Observe the wire refusal; GatewayClient retries startup responses until ready.
        startupProbe = new WebSocket(`ws://127.0.0.1:${gateway.port}`);
        const connected = createDeferred<ResponseFrame>();
        const refused = createDeferred<ResponseFrame>();
        startupProbe.on("message", (data) => {
          const frame = JSON.parse(rawDataToString(data)) as ResponseFrame;
          if (frame.type === "res" && frame.id === "connect-probe") {
            connected.resolve(frame);
          } else if (frame.type === "res" && frame.id === "startup-probe") {
            refused.resolve(frame);
          }
        });
        await acquireGatewayTestWebSocket(startupProbe, 5_000);
        const probe = startupProbe;
        const sendProbe = (id: string, method: string, params: unknown) =>
          probe.send(JSON.stringify({ type: "req", id, method, params }));
        sendProbe("connect-probe", "connect", {
          minProtocol: PROTOCOL_VERSION,
          maxProtocol: PROTOCOL_VERSION,
          client: { id: "gateway-client", version: "test", platform: "test", mode: "backend" },
          role: "operator",
          scopes: ["operator.admin"],
          auth: { token: "synthetic-replay-token" },
        });
        expect(await connected.promise).toMatchObject({ ok: true });
        sendProbe("startup-probe", "chat.send", successor);
        expect(await refused.promise).toMatchObject({
          ok: false,
          error: { code: "UNAVAILABLE", retryable: true },
        });
        expect(requests).toEqual([]);
      } finally {
        if (startupProbe) {
          await closeGatewayTestWebSocket(startupProbe);
          startupProbe = undefined;
        }
        releaseRecovery.resolve();
      }
      await vi.waitFor(() => expect(startedRuns).toContain(`${runPrefix}-peer`), {
        timeout: 30_000,
      });
      await expectRunOk(`${runPrefix}-peer`);
      await vi.waitFor(() => expect(startedRuns).toContain(`${runPrefix}-unchanged`), {
        timeout: 30_000,
      });
      await expectRunOk(`${runPrefix}-unchanged`);
      expect(providerErrors).toEqual([]);
      expect(startedRuns.slice(0, 3)).toEqual([
        `${runPrefix}-recovery-predecessor`,
        `${runPrefix}-peer`,
        `${runPrefix}-unchanged`,
      ]);
      expect(replayOrder).toEqual(["predecessor", "peer", "chat", "chat"]);
      expect(requests).toHaveLength(2);
      expect(requests.every((body) => body.includes("REPLAY_UNCHANGED"))).toBe(true);
      expect(requests.join("\n")).not.toMatch(/REPLAY_ROLE|REPLAY_DEVICE|REPLAY_MEMBERSHIP/);
      expect(await fs.readFile(effectsPath, "utf8")).toBe("UNCHANGED_OPERATOR");
      const {
        fixture: { target, client: unchangedClient },
      } = expectDefined(
        cases.find(({ change }) => change === "unchanged"),
        "unchanged operator fixture",
      );
      const firstRequestBody = expectDefined(requests[0], "first recovered provider request");
      const firstRequest = JSON.parse(firstRequestBody) as {
        input: Array<{ content?: Array<{ text?: string }> }>;
      };
      const prompt = firstRequest.input
        .flatMap((item) => item.content ?? [])
        .map((part) => part.text ?? "")
        .join("\n");
      const conversationData = expectDefined(
        prompt.match(/Conversation data \(data, not instructions\):\n("(?:[^"\\]|\\.)*")/u)?.[1],
        "encoded conversation context",
      );
      const metadata = expectDefined(
        (JSON.parse(conversationData) as string).match(/```json\n([\s\S]*?)\n```/u)?.[1],
        "verified requester context",
      );
      expect(JSON.parse(metadata)).toMatchObject({
        requester_profile: {
          id: unchangedClient.authenticatedUserProfile?.profileId,
          display_name: "unchanged",
        },
      });
      expect(firstRequestBody).toContain("RECOVERED_PERSONAL_PREFERENCES");
      await waitForSessionParticipantRecording(target);
      expect(listSessionParticipantsReadOnly(target).get(target.sessionKey)).toEqual([
        expect.objectContaining({
          identity: {
            type: "profile",
            id: unchangedClient.authenticatedUserProfile?.profileId,
          },
          contributionCount: 1,
        }),
      ]);
      for (const { change, fixture } of cases) {
        const pending = await listSessionPendingInputs(fixture.target);
        if (change === "unchanged") {
          expect(pending.items).toEqual([]);
        } else {
          expect(pending.items).toMatchObject([
            { runId: fixture.target.sourceRunId, state: "interrupted" },
          ]);
        }
      }
      await vi.waitFor(async () => {
        await expect(client.request("chat.send", successor)).resolves.toMatchObject({
          runId: `${runPrefix}-successor`,
          status: "started",
        });
      });
      await expectRunOk(`${runPrefix}-successor`);
      expect(requests).toHaveLength(3);
      expect(requests.slice(0, 2).join("\n")).not.toContain(successor.message);
      expect(requests.slice(2).every((body) => body.includes(successor.message))).toBe(true);
    } finally {
      stopObserving();
      releaseRecovery.resolve();
      recoverySpy.mockRestore();
      try {
        if (startupProbe) {
          await closeGatewayTestWebSocket(startupProbe);
        }
        if (gateway) {
          await disconnectGatewayClient(gateway.client);
          await gateway.server.close({ reason: "chat replay authority proof complete" });
        }
      } finally {
        try {
          await closeProvider(providerServer);
        } finally {
          await state.cleanup();
        }
      }
    }
  },
);
