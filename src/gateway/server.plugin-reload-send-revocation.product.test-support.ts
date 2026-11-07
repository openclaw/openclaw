import assert from "node:assert/strict";
import { randomUUID, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it, vi } from "vitest";
import { readRequestText } from "../../test/helpers/gateway-integration-fixtures.js";
import {
  assertManagedHandoffTestConsumer,
  createManagedHandoffTestBinding,
} from "../../test/helpers/managed-handoff-isolation.js";
import { startOpenAiResponsesModelServer } from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import * as delivery from "../agents/tools/sessions-send-tool.delivery.js";
import {
  listSessionPendingInputs,
  loadTranscriptEvents,
} from "../config/sessions/session-accessor.js";
import { readSessionEntryReadOnlyInWorker } from "../config/sessions/session-entry-read-runtime.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { onAgentEvent } from "../infra/agent-events.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { resolvePluginArtifactDeclaredSurface } from "../plugins/capability-artifact.js";
import { resolvePluginCapabilityConsent } from "../plugins/capability-consent.js";
import { computeDeclaredSurfaceHash } from "../plugins/capability-summary.js";
import { getPluginInstance, type PluginInstanceHandle } from "../plugins/plugin-instance-scope.js";
import { watchPluginReplacement } from "../plugins/plugin-replacement-watchers.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { seedInstalledPluginIndex } from "../plugins/test-helpers/installed-plugin-index.js";
import { onSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { writeToolCall } from "./gateway-provider-fixture.test-support.js";
import {
  output,
  PLUGIN,
  TOOL,
  writePlugin,
  type InputItem,
} from "./server.plugin-reload-product-fixture.test-support.js";
import { createSubagentModelConfig } from "./server.subagent-stop-settlement.product.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";

const ROOT = "Hold the probe, then send Bob's continuation to the shared target exactly once.";
const STEER = "BOB-STEER-7d2e: please send the continuation for me.";
const MESSAGE = "BOB-SELECTED-CONTINUATION-7d2e";
const DONE = "BOB-TARGET-COMPLETED-7d2e";
const WAKE =
  "Continue the original task in this conversation. Do not repeat a completed operation.";
const UNDELIVERED = "could not continue this conversation automatically";
// Observed refusal: Bob's revoked authority ends the retained Gateway continuation.
const CONTINUATION_REVOKED = "Gateway continuation authority is no longer active";
const ORIGIN = "https://control.revocation.example.test";
const ADMIN = "admin@revocation.example.test";
const ALICE = "alice@revocation.example.test";
const BOB = "bob@revocation.example.test";
const memberScopes: Array<"operator.read" | "operator.write"> = ["operator.read", "operator.write"];
const adminScopes: Array<"operator.admin"> = ["operator.admin"];

type Client = Awaited<ReturnType<typeof connectGatewayClient>>;

function messageText(event: unknown): string {
  assert(isRecord(event) && isRecord(event.message), JSON.stringify(event));
  const content = event.message.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .flatMap((part) => (isRecord(part) && typeof part.text === "string" ? [part.text] : []))
          .join("\n")
      : "";
}

function between(text: string, start: string, end: string): unknown {
  const from = text.indexOf(start);
  const to = text.indexOf(end, from);
  assert(from >= 0 && to > from, text);
  return JSON.parse(text.slice(from + start.length, to));
}
type GatewayRequest = Parameters<typeof delivery.callSessionsSendGateway>[0];

it.for(["allowed", "revoked"] as const)(
  "settles Bob's selected retained send when Bob is %s before replay admission",
  async (scenario, { signal }) => {
    const revoked = scenario === "revoked";
    const state = await createOpenClawTestState({ label: "plugin-reload-send-revocation" });
    const inheritedHandoff = process.env.OPENCLAW_TEST_PRIVATE_HANDOFF_PATH;
    assert(inheritedHandoff, "Product entry must bind the handoff store before imports");
    const handoffBinding = createManagedHandoffTestBinding(path.dirname(inheritedHandoff));
    const pluginRoot = state.path("external-plugin");
    const hooksFile = state.path("hooks.log");
    const rootKey = "agent:main:dashboard:" + randomUUID();
    const targetKey = "agent:main:dashboard:" + randomUUID();
    const parentRunId = randomUUID();
    const sendResult = createDeferred<Record<string, unknown>>();
    const failure = createDeferred<never>();
    void failure.promise.catch(() => {});
    const targetEffect = createDeferred();
    const handoffWake = createDeferred<string>();
    const notice = createDeferred<string>();
    let held: PluginInstanceHandle | undefined;
    let reload: Promise<unknown> | undefined;
    let unwatch = () => {};
    let probes = 0;
    let steered = false;
    let sent = false;
    let sendStarts = 0;
    let effects = 0;
    let messageRequests = 0;
    let auxiliaryRootRequests = 0;
    let bobProfileId: string | undefined;
    const wakes: string[] = [];
    const notices: string[] = [];
    const seenRootUserItems = new Set<string>();
    const sendEvents: string[] = [];
    // The retained receipt causally precedes any replay; the barrier arms only from it.
    let armedRunId: string | undefined;
    const barrier: Array<{ rootEnded: boolean; replacementPending: boolean | undefined }> = [];
    let rootEnded = false;
    let settledOutcome: unknown;
    let revocation: { method: string; bobRefused: boolean } | undefined;
    let admin: Client | undefined;
    let alice: Client | undefined;
    let bob: Client | undefined;
    let bobDeviceId: string | undefined;
    let revokeMethod: "device.token.revoke" | "device.pair.remove" | undefined;
    const stopEvents = onAgentEvent((event) => {
      if (
        event.runId === parentRunId &&
        event.stream === "lifecycle" &&
        (event.data.phase === "end" || event.data.phase === "error")
      ) {
        rootEnded = true;
      }
      if (event.runId !== parentRunId || event.stream !== "tool") {
        return;
      }
      if (event.data.name !== "sessions_send") {
        return;
      }
      sendEvents.push(String(event.data.phase));
      if (event.data.phase === "start") {
        sendStarts++;
      }
      if (event.data.phase !== "result") {
        return;
      }
      const result = event.data.result as { details?: Record<string, unknown> } | undefined;
      const details = result?.details;
      if (!details) {
        return;
      }
      const retained = isRecord(details.retained) ? details.retained : undefined;
      if (
        details.status === "started" &&
        retained?.acceptance === "not_accepted" &&
        retained.reason === "plugin_reload_self_hold" &&
        typeof details.runId === "string"
      ) {
        armedRunId = details.runId;
      }
      sendResult.resolve(details);
    });
    const stopTranscript = onSessionTranscriptUpdate((update) => {
      if (update.sessionKey !== rootKey) {
        return;
      }
      const text = JSON.stringify(update.message ?? "");
      if (text.includes(UNDELIVERED)) {
        notices.push(text);
        notice.resolve(text);
      }
    });
    const callThrough = delivery.callSessionsSendGateway;
    const dispatches: Array<{ method: string; idempotencyKey: unknown }> = [];
    const gatewayCalls = vi
      .spyOn(delivery, "callSessionsSendGateway")
      .mockImplementation(async <T>(request: GatewayRequest): Promise<T> => {
        const params = isRecord(request.params) ? request.params : {};
        dispatches.push({ method: request.method, idempotencyKey: params.idempotencyKey });
        if (
          armedRunId &&
          request.method === "agent" &&
          params.idempotencyKey === armedRunId &&
          barrier.length === 0
        ) {
          // Record, never decide: the real Gateway route below owns admission.
          barrier.push({ rootEnded, replacementPending: held?.replacementPending });
          if (revoked) {
            assert(admin && bob && bobDeviceId && revokeMethod);
            await admin.request(
              revokeMethod,
              revokeMethod === "device.token.revoke"
                ? { deviceId: bobDeviceId, role: "operator" }
                : { deviceId: bobDeviceId },
            );
            const bobRefused = await bob.request("users.self", {}).then(
              () => false,
              () => true,
            );
            revocation = { method: revokeMethod, bobRefused };
          }
        }
        return await callThrough<T>(request);
      });
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let model: Awaited<ReturnType<typeof startOpenAiResponsesModelServer>> | undefined;
    try {
      await writePlugin(pluginRoot, hooksFile, state.path("generation"));
      model = await startOpenAiResponsesModelServer({
        modelId: "reload-revocation-proof",
        bindError: "Expected private revocation model server",
        onRequest: async (request, response) => {
          try {
            const raw = await readRequestText(request);
            const body = JSON.parse(raw) as {
              input?: InputItem[];
              tools?: Array<{ name?: string }>;
            };
            // Only the agent turn offers tools; auxiliary model calls can repeat its text.
            const agentTurn = (body.tools ?? []).some((tool) => tool.name === TOOL);
            const reply = (text: string) =>
              writeOpenAiResponsesText(response, {
                text,
                messageId: randomUUID(),
                responseId: randomUUID(),
              });
            if (raw.includes(ROOT)) {
              if (!agentTurn) {
                auxiliaryRootRequests++;
                reply("NO_REPLY");
                return;
              }
              if (probes === 0) {
                probes++;
                writeToolCall(response, TOOL, {});
                return;
              }
              if (!steered) {
                expect(output(body, TOOL)).toMatchObject({ plugin: PLUGIN, generation: 1 });
                steered = true;
                assert(bob);
                // Bob joins Alice's running shared turn through the real steering path.
                const steer = await bob.request<{ status: string }>("chat.send", {
                  sessionKey: rootKey,
                  message: STEER,
                  idempotencyKey: randomUUID(),
                  deliver: false,
                  queueMode: "steer",
                });
                expect(steer.status).toBe("started");
                probes++;
                writeToolCall(response, TOOL, {});
                return;
              }
              if (!sent) {
                // Select Bob only after the model observed his accepted steer.
                assert(raw.includes(STEER), "Bob's steer must reach the model before selection");
                const record = getActivePluginRegistry()?.plugins.find(
                  (item) => item.id === PLUGIN,
                );
                assert(record, "The actual Gateway must publish the external plugin");
                held = getPluginInstance(record);
                assert(held, "The caller must hold the actual loaded instance");
                expect(held.retentionSnapshot().total).toBeGreaterThan(0);
                const replacement = createDeferred();
                unwatch = watchPluginReplacement(held, () => replacement.resolve());
                assert(admin && bobProfileId);
                reload = admin.request("plugins.reload", { plugins: [{ pluginId: PLUGIN }] });
                await withinTest(
                  awaitGateBeforeSettlement(
                    replacement.promise,
                    reload,
                    "Reload settled without reserving the held instance",
                  ),
                  signal,
                );
                expect(held.replacementPending).toBe(true);
                sent = true;
                writeToolCall(response, "sessions_send", {
                  sessionKey: targetKey,
                  message: MESSAGE,
                  mode: "followup",
                  timeoutSeconds: 0,
                  user: bobProfileId,
                });
                return;
              }
              const items = body.input ?? [];
              const call = items.findLast(
                (item) => item.type === "function_call" && item.name === "sessions_send",
              );
              const outputIndex = items.findIndex(
                (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
              );
              const users =
                outputIndex < 0
                  ? []
                  : items.slice(outputIndex + 1).filter((item) => item.role === "user");
              for (const item of users) {
                const text = JSON.stringify(item);
                if (seenRootUserItems.has(text)) {
                  continue;
                }
                seenRootUserItems.add(text);
                for (let count = text.split(WAKE).length - 1; count > 0; count--) {
                  wakes.push(text);
                  handoffWake.resolve(text);
                }
              }
              // Never retry, including after a refusal or a host-originated input.
              reply("Caller finished without retrying the send.");
              return;
            }
            if (raw.includes(MESSAGE)) {
              messageRequests++;
            }
            if (raw.includes(MESSAGE) && agentTurn) {
              effects++;
              targetEffect.resolve();
              reply(DONE);
              return;
            }
            reply("NO_REPLY");
          } catch (error) {
            failure.reject(error);
            response.destroy(error instanceof Error ? error : undefined);
          }
        },
      });
      const base = createSubagentModelConfig(state.workspaceDir, {
        baseUrl: model.baseUrl + "/v1",
        modelId: "reload-revocation-proof",
        name: "Reload revocation proof",
        runtime: true,
      });
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const trustedProxy = {
        userHeader: "x-forwarded-user",
        requiredHeaders: ["x-forwarded-proto"],
        allowUsers: [ADMIN, ALICE, BOB],
        allowLoopback: true,
        deviceAutoApprove: { enabled: true, scopes: [...adminScopes, ...memberScopes] },
      };
      const cfg = {
        ...base,
        skills: { load: { watch: false } },
        plugins: {
          enabled: true,
          allow: [PLUGIN],
          load: { paths: [pluginRoot] },
          slots: { memory: "none" },
          entries: { [PLUGIN]: { enabled: true, hooks: { allowConversationAccess: true } } },
        },
        tools: {
          profile: "full" as const,
          codeMode: false,
          toolSearch: false,
          sessions: { visibility: "all" as const },
        },
        // Private fixture opt-in to the existing collaborative steering policy.
        messages: { queue: { allowCollaborativeSteering: true } },
        gateway: {
          auth: {
            mode: "trusted-proxy" as const,
            trustedProxy,
            identityScopes: { [ADMIN]: adminScopes },
          },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: [ORIGIN] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: {
            default: "member",
            definitions: {
              administrator: { sessions: { others: "write" }, agents: "*", scopes: adminScopes },
              // Membership grants write only above a view cap; "none" keeps non-owners viewers.
              member: { sessions: { others: "view" }, agents: "*", scopes: memberScopes },
            },
          },
        },
      } satisfies OpenClawConfig;
      await state.writeConfig(cfg);
      setUserProfileRole(ensureProfileForEmail(ADMIN).id, "administrator");
      await seedInstalledPluginIndex(
        { [PLUGIN]: { source: "path", sourcePath: pluginRoot, installPath: pluginRoot } },
        { env: process.env, config: cfg },
      );
      await resolvePluginCapabilityConsent({
        config: cfg,
        pluginId: PLUGIN,
        env: process.env,
        acknowledge: {
          reviewToken: computeDeclaredSurfaceHash(
            resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, { config: cfg }),
          ),
        },
      });
      const connection = (scopes: string[]) => ({
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        origin: ORIGIN,
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes,
      });
      const edge = (user: string, forwardedFor: string) => ({
        "x-forwarded-for": forwardedFor,
        "x-forwarded-proto": "https",
        "x-forwarded-user": user,
      });
      gateway = await startGatewayWithClient({
        ...connection(adminScopes),
        cfg,
        configPath: state.configPath,
        portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
        auth: cfg.gateway.auth,
        edgeAuthHeaders: edge(ADMIN, "203.0.113.70"),
        secure: true,
      });
      admin = gateway.client;
      await withinTest(gateway.server.startupSettled, signal);
      const connectAs = (user: string, name: string, forwardedFor: string) => {
        const deviceIdentity = loadOrCreateDeviceIdentity({
          path: state.statePath("test-device-identities", name, "client", "credentials.sqlite"),
        });
        return {
          deviceId: deviceIdentity.deviceId,
          client: connectGatewayClient({
            ...connection(memberScopes),
            url: `wss://127.0.0.1:${gateway!.port}`,
            edgeAuthHeaders: edge(user, forwardedFor),
            deviceIdentity,
          }),
        };
      };
      alice = await connectAs(ALICE, "alice", "203.0.113.71").client;
      const bobConnection = connectAs(BOB, "bob", "203.0.113.72");
      bobDeviceId = bobConnection.deviceId;
      bob = await bobConnection.client;
      const self = async (client: Client) =>
        (await client.request<{ profile: { id: string } }>("users.self", {})).profile.id;
      const aliceProfileId = await self(alice);
      bobProfileId = await self(bob);
      expect(aliceProfileId).not.toBe(bobProfileId);
      // Choose the real revocation route from the observed pairing, before any attempt.
      const pairing = await admin.request<{
        paired: Array<{ deviceId: string; tokens?: Array<{ role: string }> }>;
      }>("device.pair.list", {});
      const bobDevice = pairing.paired.find((device) => device.deviceId === bobDeviceId);
      assert(bobDevice, "Bob's device must be paired through auto-approval");
      revokeMethod = bobDevice.tokens?.some((token) => token.role === "operator")
        ? "device.token.revoke"
        : "device.pair.remove";
      for (const key of [rootKey, targetKey]) {
        const created = await alice.request<{ key: string }>("sessions.create", {
          key,
          agentId: "main",
          visibility: "shared",
        });
        expect(created.key).toBe(key);
        await alice.request("session.members.add", { sessionKey: key, identityId: bobProfileId });
        await bob.request("chat.history", { sessionKey: key });
      }
      await alice.request("chat.send", {
        sessionKey: rootKey,
        message: ROOT,
        idempotencyKey: parentRunId,
        deliver: false,
      });
      const result = await withinTest(Promise.race([sendResult.promise, failure.promise]), signal);
      expect(result).toMatchObject({
        status: "started",
        retained: {
          acceptance: "not_accepted",
          reason: "plugin_reload_self_hold",
          plugins: [PLUGIN],
        },
      });
      expect(armedRunId).toBe(result.runId);
      expect(
        await withinTest(
          alice.request("agent.wait", { runId: parentRunId, timeoutMs: 30_000 }),
          signal,
        ),
      ).toMatchObject({ status: "ok" });
      assert(reload);
      expect(await withinTest(reload, signal)).toMatchObject({ ok: true });
      await withinTest(
        Promise.race([
          revoked ? notice.promise : Promise.all([targetEffect.promise, handoffWake.promise]),
          failure.promise,
        ]),
        signal,
      );
      const rootSettled = await withinTest(
        alice.request("agent.wait", { runId: parentRunId, timeoutMs: 30_000 }),
        signal,
      );
      expect(rootSettled).toMatchObject({ status: "ok" });
      const targetEntry = await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        sessionKey: targetKey,
      });
      const targetReceipts = targetEntry?.sessionId
        ? (
            await loadTranscriptEvents({
              agentId: "main",
              sessionKey: targetKey,
              sessionId: targetEntry.sessionId,
            })
          ).filter(
            (event) =>
              isRecord(event) &&
              event.type === "message" &&
              isRecord(event.message) &&
              event.message.role === "user" &&
              JSON.stringify(event.message.content).includes(MESSAGE),
          )
        : [];
      const rootEntry = await readSessionEntryReadOnlyInWorker({
        agentId: "main",
        sessionKey: rootKey,
      });
      assert(rootEntry?.sessionId);
      const rootTranscript = await loadTranscriptEvents({
        agentId: "main",
        sessionKey: rootKey,
        sessionId: rootEntry.sessionId,
      });
      const durableNotices = rootTranscript.filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.role === "assistant" &&
          JSON.stringify(event.message.content).includes(UNDELIVERED),
      );
      const durableWakes = rootTranscript.filter(
        (event) =>
          isRecord(event) &&
          event.type === "message" &&
          isRecord(event.message) &&
          event.message.role === "user" &&
          JSON.stringify(event.message.content).includes(WAKE),
      );
      expect(sendStarts).toBe(1);
      expect(sendEvents.filter((phase) => phase === "result")).toHaveLength(1);
      expect(barrier).toHaveLength(1);
      // Replay is gated on the healthy replacement outcome, never on the pending reservation.
      expect(barrier[0]?.replacementPending).toBe(false);
      expect(held?.retentionSnapshot().total).toBe(0);
      expect(
        dispatches.filter((call) => call.method === "agent").map((call) => call.idempotencyKey),
      ).toEqual([result.runId, result.runId]);
      expect(gatewayCalls).toHaveBeenCalled();
      if (targetEntry?.sessionId) {
        expect(
          await listSessionPendingInputs({
            agentId: "main",
            sessionKey: targetKey,
            sessionId: targetEntry.sessionId,
          }),
        ).toEqual({ items: [], total: 0 });
      }
      if (revoked) {
        expect(revocation).toEqual({ method: revokeMethod, bobRefused: true });
        expect(effects).toBe(0);
        expect(messageRequests).toBe(0);
        expect(targetReceipts).toHaveLength(0);
        expect(wakes).toHaveLength(0);
        expect(durableWakes).toHaveLength(0);
        expect(durableNotices).toHaveLength(1);
        expect(notices).toHaveLength(1);
        // The host notice carries the refused replay's own settled outcome.
        const noticeText = messageText(durableNotices[0]);
        expect(noticeText).toContain(UNDELIVERED + ": " + CONTINUATION_REVOKED);
        settledOutcome = between(noticeText, "Its result: ", ". Send a message");
        expect(settledOutcome).toEqual({
          outcomes: [
            {
              runId: result.runId,
              status: "error",
              error: CONTINUATION_REVOKED,
              sessionKey: targetKey,
            },
          ],
        });
        // Alice's own authority still admits a real request after Bob's revocation.
        expect(await self(alice)).toBe(aliceProfileId);
      } else {
        expect(revocation).toBeUndefined();
        expect(effects).toBe(1);
        expect(targetReceipts).toHaveLength(1);
        expect(wakes).toHaveLength(1);
        expect(durableWakes).toHaveLength(1);
        expect(durableNotices).toHaveLength(0);
        settledOutcome = between(
          messageText(durableWakes[0]),
          "Session send result: ",
          "\n" + WAKE,
        );
        expect(settledOutcome).toMatchObject({
          outcomes: [{ runId: result.runId, status: "accepted", sessionKey: targetKey }],
        });
      }
      const hooks = (await fs.readFile(hooksFile, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { event: string; runId?: string });
      expect(
        hooks.filter((hook) => hook.event === "agent_end" && hook.runId === parentRunId),
      ).toHaveLength(1);
    } finally {
      unwatch();
      stopEvents();
      stopTranscript();
      await model?.close();
      for (const client of [alice, bob]) {
        if (client) {
          await disconnectGatewayClient(client).catch(() => {});
        }
      }
      if (gateway) {
        await disconnectGatewayClient(gateway.client);
        await gateway.server.close({ reason: "reload revocation proof complete" });
      }
      if (reload) {
        await Promise.allSettled([reload]);
      }
      vi.restoreAllMocks();
      await state.cleanup();
      assertManagedHandoffTestConsumer(
        handoffBinding,
        process.pid,
        path.join(process.cwd(), "src/infra"),
      );
      await fs.writeFile(
        path.join(handoffBinding.directory, `revocation-case-${scenario}.json`),
        JSON.stringify({
          scenario,
          pid: process.pid,
          runtime: process.versions.bun ? "bun" : "node",
          sendStarts,
          effects,
          wakes: wakes.length,
          notices: notices.length,
          barrierFired: barrier.length,
          barrierFacts: barrier,
          settledOutcome,
          auxiliaryRootRequests,
          messageRequests,
          revocation,
          databasePath: handoffBinding.databasePath,
        }),
      );
    }
  },
);
