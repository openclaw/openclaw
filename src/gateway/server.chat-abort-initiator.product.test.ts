// Load the real Gateway/model owners outside the behavioral deadline.
import "../agents/prepared-model-runtime.js";
import "./server-start.js";
import { randomUUID, X509Certificate } from "node:crypto";
import { expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { replaceSessionEntry } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import * as execRequest from "../infra/exec-request-context.js";
import { requireActivePluginRegistry } from "../plugins/runtime.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { acquireTestPortBlock } from "../test-utils/port-claims.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as chatAbort from "./chat-abort.js";
import { closeProvider, listenProvider } from "./gateway-provider-fixture.test-support.js";
import type { OperatorScope } from "./operator-scopes.js";
import * as abortPreparation from "./server-methods/chat-aborted-partial.js";
import * as sendPreparation from "./server-methods/chat-send-admission-context.js";
import {
  createProductState,
  productModelConfig,
  productProvider,
} from "./server.chat-product.test-support.js";
import {
  connectGatewayClient,
  disconnectGatewayClient,
  startGatewayWithClient,
} from "./test-helpers.e2e.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

it(
  "binds cross-device Stop to the initiating person, current access and exact source",
  { timeout: 90_000 },
  async ({ signal }) => {
    const state = await createProductState("chat-abort-initiator");
    type Client = Awaited<ReturnType<typeof connectGatewayClient>>;
    const clients: Client[] = [];
    const holds: Array<{
      entered: ReturnType<typeof createDeferred<void>>;
      release: ReturnType<typeof createDeferred<void>>;
    }> = [];
    const terminals = new Map<string, ReturnType<typeof createDeferred<string>>>();
    const terminal = (runId: string) => {
      let value = terminals.get(runId);
      if (!value) {
        value = createDeferred<string>();
        terminals.set(runId, value);
      }
      return value.promise;
    };
    const onEvent = ({ event, payload }: { event?: string; payload?: unknown }) => {
      if (event !== "chat") {
        return;
      }
      const value = payload as { runId: string; state: string };
      if (!["final", "error", "aborted"].includes(value.state)) {
        return;
      }
      void terminal(value.runId);
      terminals.get(value.runId)!.resolve(value.state);
    };
    const wait = <T>(work: Promise<T>) => withinTest(work, signal);
    const errors: unknown[] = [];
    const cancellation = vi.spyOn(chatAbort, "abortChatRunById");
    const custody = new Map<string, execRequest.ExecRequestCustody>();
    const originalTurn = execRequest.withExecRequestTurn;
    const captureTurn = vi
      .spyOn(execRequest, "withExecRequestTurn")
      .mockImplementation(<T>(params: Parameters<typeof originalTurn>[0], run: () => Promise<T>) =>
        originalTurn(params, async () => {
          const captured = execRequest.captureExecRequestCustody(params.identity);
          if (captured && params.identity.runId) {
            custody.set(params.identity.runId, captured);
          }
          return run();
        }),
      );
    let removeNativeHarness: (() => void) | undefined;
    const providerServer = productProvider(errors, async (_body, response) => {
      const hold = holds.shift();
      if (!hold) {
        throw new Error("Unexpected model dispatch");
      }
      response.once("close", () => hold.release.resolve());
      hold.entered.resolve();
      await hold.release.promise;
      if (!response.destroyed) {
        writeOpenAiResponsesText(response, {
          text: "Finished.",
          messageId: randomUUID(),
          responseId: randomUUID(),
        });
      }
    });
    const holdNext = () => {
      const value = { entered: createDeferred(), release: createDeferred() };
      holds.push(value);
      return value;
    };
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    const releasePreparation = createDeferred();
    const releaseAbort = createDeferred();
    let prepareSend: { mockRestore(): void } | undefined;
    let prepareAbort: { mockRestore(): void } | undefined;
    try {
      const provider = buildMockOpenAiResponsesProvider(
        await listenProvider(providerServer),
        "abort-initiator",
      );
      const model = productModelConfig(state.workspaceDir, provider);
      const scopes: OperatorScope[] = ["operator.read", "operator.write"];
      const certPath = await state.writeText("tls/cert.pem", TEST_TLS_CERT_PEM);
      const keyPath = await state.writeText("tls/key.pem", TEST_TLS_KEY_PEM);
      const cfg = {
        agents: { defaults: model.defaults },
        models: model.models,
        plugins: { enabled: false, slots: { memory: "none" } },
        tools: { profile: "minimal" },
        gateway: {
          auth: {
            mode: "trusted-proxy",
            trustedProxy: {
              userHeader: "x-forwarded-user",
              requiredHeaders: ["x-forwarded-proto"],
              allowUsers: ["alice@example.test", "bob@example.test"],
              allowLoopback: true,
              deviceAutoApprove: { enabled: true, scopes },
            },
          },
          trustedProxies: ["127.0.0.1"],
          controlUi: { allowedOrigins: ["https://control.example.com"] },
          tls: { enabled: true, autoGenerate: false, certPath, keyPath },
          roles: {
            default: "writer",
            definitions: {
              writer: { sessions: { others: "write" }, agents: "*", scopes },
              none: { sessions: { others: "none" }, agents: "*", scopes: [] },
            },
          },
        },
      } satisfies OpenClawConfig;
      const connection = {
        clientName: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
        origin: "https://control.example.com",
        tlsFingerprint: new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256,
        scopes,
        onEvent,
      };
      const identity = (name: string) =>
        loadOrCreateDeviceIdentity({
          path: state.statePath("test-device-identities", name, "client", "credentials.sqlite"),
        });
      const headers = (user: string) => ({
        "x-forwarded-user": `${user}@example.test`,
        "x-forwarded-for": "203.0.113.50",
        "x-forwarded-proto": "https",
      });
      const firstDevice = identity("first");
      const secondDevice = identity("second");
      expect(firstDevice.deviceId).not.toBe(secondDevice.deviceId);
      gateway = await startGatewayWithClient({
        ...connection,
        edgeAuthHeaders: headers("alice"),
        cfg,
        configPath: state.configPath,
        portClaim: await acquireTestPortBlock({ offsets: [0, 1, 2, 3, 4] }),
        auth: cfg.gateway.auth,
        secure: true,
      });
      await gateway.server.startupSettled;
      clients.push(gateway.client);
      await disconnectGatewayClient(gateway.client);
      const connect = async (user: string, device: ReturnType<typeof identity>) => {
        const client = await connectGatewayClient({
          ...connection,
          url: `wss://127.0.0.1:${gateway!.port}`,
          deviceIdentity: device,
          edgeAuthHeaders: headers(user),
        });
        clients.push(client);
        return client;
      };
      const first = await connect("alice", firstDevice);
      const second = await connect("alice", secondDevice);
      const bob = await connect("bob", identity("bob"));
      const profile = async (client: Client) =>
        (await client.request<{ profile: { id: string } }>("users.self", {})).profile.id;
      const aliceId = await profile(first);
      const bobId = await profile(bob);
      expect(aliceId).not.toBe(GATEWAY_OWNER_PROFILE_ID);
      expect(await profile(second)).toBe(aliceId);
      expect(bobId).not.toBe(aliceId);
      const sessionKey = `agent:main:abort-initiator-${randomUUID()}`;
      const sessionId = randomUUID();
      await replaceSessionEntry(
        { agentId: "main", sessionKey },
        {
          sessionId,
          updatedAt: Date.now(),
          visibility: "shared",
          createdActor: { type: "human", source: "profile", id: aliceId },
        },
      );
      const send = (client: Client, runId = randomUUID(), queueMode?: "followup") =>
        client.request<{ runId: string; status: string }>("chat.send", {
          sessionKey,
          message: `Prepare dispatch report ${runId}`,
          idempotencyKey: runId,
          deliver: false,
          queueMode,
        });
      const stop = (client: Client, runId: string, extra: Record<string, unknown> = {}) =>
        client.request<{ aborted: boolean; runIds: string[] }>("chat.abort", {
          sessionKey,
          runId,
          ...extra,
        });

      // The same initiating source is cancellable after operator admission, before dispatch.
      const prepared = createDeferred();
      const originalPrepare = sendPreparation.prepareChatSendAcpMetadata;
      prepareSend = vi
        .spyOn(sendPreparation, "prepareChatSendAcpMetadata")
        .mockImplementation(async (...args) => {
          const value = await originalPrepare(...args);
          prepared.resolve();
          await releasePreparation.promise;
          return value;
        });
      const preparingId = randomUUID();
      const preparing = send(first, preparingId);
      void preparing.catch(() => {});
      await wait(
        awaitGateBeforeSettlement(
          prepared.promise,
          preparing,
          "Input settled before operator preparation",
        ),
      );
      expect(await stop(second, preparingId)).toMatchObject({
        aborted: true,
        runIds: [preparingId],
      });
      releasePreparation.resolve();
      await wait(preparing);
      prepareSend.mockRestore();
      prepareSend = undefined;

      const activeHold = holdNext();
      const active = await send(first);
      await wait(
        awaitGateBeforeSettlement(
          activeHold.entered.promise,
          terminal(active.runId),
          "Run settled before provider",
        ),
      );
      // Bob can write this shared conversation, but its assigned owner is not the initiator.
      expect(await stop(bob, "missing-run")).toMatchObject({ aborted: false });
      await expect(stop(bob, active.runId)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "unauthorized",
      });
      await first.request("sessions.assignOwner", {
        key: sessionKey,
        owner: { type: "human", id: bobId },
      });
      await expect(stop(bob, active.runId)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "unauthorized",
      });
      await expect(stop(second, active.runId, { sessionId: randomUUID() })).rejects.toMatchObject({
        code: "INVALID_REQUEST",
      });
      expect(
        cancellation.mock.calls.filter(([, params]) => params.runId === active.runId),
      ).toHaveLength(0);

      const bobHold = holdNext();
      const bobQueued = await send(bob, randomUUID(), "followup");
      const aliceQueued = await send(first, randomUUID(), "followup");
      await expect(
        stop(second, bobQueued.runId, { discardPendingInput: true }),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST", message: "unauthorized" });
      expect(await stop(second, aliceQueued.runId, { discardPendingInput: true })).toMatchObject({
        aborted: true,
        runIds: [aliceQueued.runId],
      });
      await disconnectGatewayClient(first);
      expect(await stop(second, active.runId)).toMatchObject({
        aborted: true,
        runIds: [active.runId],
      });
      expect(await wait(terminal(active.runId))).toBe("aborted");
      await wait(
        awaitGateBeforeSettlement(
          bobHold.entered.promise,
          terminal(bobQueued.runId),
          "Foreign queued input did not survive exact Stop",
        ),
      );
      await expect(stop(second, bobQueued.runId)).rejects.toMatchObject({
        code: "INVALID_REQUEST",
        message: "unauthorized",
      });
      const bobSecond = await connect("bob", identity("bob-second"));
      expect(await profile(bobSecond)).toBe(bobId);
      expect(await stop(bobSecond, bobQueued.runId)).toMatchObject({ aborted: true });
      expect(await wait(terminal(bobQueued.runId))).toBe("aborted");

      const reconnected = await connect("alice", firstDevice);
      const sessionHold = holdNext();
      const sessionRun = await send(second);
      await wait(
        awaitGateBeforeSettlement(
          sessionHold.entered.promise,
          terminal(sessionRun.runId),
          "Session run settled before provider",
        ),
      );
      const followup = await send(second, randomUUID(), "followup");
      const foreignHold = holdNext();
      const foreignSessionKey = `agent:main:foreign-native-${randomUUID()}`;
      const foreignRun = await bob.request<{ runId: string }>("chat.send", {
        sessionKey: foreignSessionKey,
        message: "Prepare the independent dispatch report",
        idempotencyKey: randomUUID(),
        deliver: false,
      });
      await wait(
        awaitGateBeforeSettlement(
          foreignHold.entered.promise,
          terminal(foreignRun.runId),
          "Foreign run settled before provider",
        ),
      );
      // Capture real dispatch custody; the fixture models only the external child effect.
      // Retired Bob custody also exercises a foreign native owner in this same writable chat.
      const nativeRunIds = [sessionRun.runId, foreignRun.runId, bobQueued.runId];
      const children = nativeRunIds.map((runId) => {
        const requestCustody = custody.get(runId);
        expect(requestCustody).toBeDefined();
        return { runId, requestCustody, cancel: vi.fn() };
      });
      const hooks = requireActivePluginRegistry().agentHarnesses;
      const registration = {
        pluginId: "core",
        source: "runtime",
        harness: {
          id: "initiator-native-stop",
          label: "Native Stop fixture",
          supports: () => ({ supported: false }),
          runAttempt: async () => {
            throw new Error("No inference in cancellation fixture");
          },
          withDescendantCancellation: (params, run) =>
            run(async () => {
              const selected = children.filter((child) =>
                params.acceptsRequest(child.requestCustody),
              );
              selected.forEach((child) => child.cancel());
              return { killed: selected.length, cancelledRequesters: [] };
            }),
        },
      } satisfies (typeof hooks)[number];
      hooks.push(registration);
      removeNativeHarness = () => {
        const index = hooks.indexOf(registration);
        if (index >= 0) {
          hooks.splice(index, 1);
        }
      };
      expect(
        await reconnected.request("sessions.abort", { key: sessionKey, clearQueued: true }),
      ).toMatchObject({ status: "aborted" });
      expect(await wait(terminal(sessionRun.runId))).toBe("aborted");
      expect(children[0]?.cancel).toHaveBeenCalledOnce();
      expect(children[1]?.cancel).not.toHaveBeenCalled();
      expect(children[2]?.cancel).not.toHaveBeenCalled();
      expect(await bobSecond.request("sessions.abort", { key: sessionKey })).toMatchObject({
        status: "aborted",
      });
      expect(children[2]?.cancel).toHaveBeenCalledOnce();
      expect(children[0]?.cancel).toHaveBeenCalledOnce();
      expect(
        await bob.request("chat.abort", {
          sessionKey: foreignSessionKey,
          runId: foreignRun.runId,
        }),
      ).toMatchObject({ aborted: true });
      expect(await wait(terminal(foreignRun.runId))).toBe("aborted");
      expect(await stop(reconnected, followup.runId)).toMatchObject({ aborted: false });
      expect(await second.request("chat.history", { sessionKey, limit: 1 })).toMatchObject({
        pendingInputs: { queuedCount: 0 },
      });

      // Revoke the Stop request's current role while real metadata preparation awaits.
      const revokeHold = holdNext();
      const revokeRun = await send(second);
      await wait(
        awaitGateBeforeSettlement(
          revokeHold.entered.promise,
          terminal(revokeRun.runId),
          "Revocation run settled before provider",
        ),
      );
      const abortPrepared = createDeferred();
      const originalAbort = abortPreparation.prepareChatAbortSessionSnapshot;
      prepareAbort = vi
        .spyOn(abortPreparation, "prepareChatAbortSessionSnapshot")
        .mockImplementation(async (...args) => {
          const value = await originalAbort(...args);
          abortPrepared.resolve();
          await releaseAbort.promise;
          return value;
        });
      const denied = stop(reconnected, revokeRun.runId);
      void denied.catch(() => {});
      await wait(
        awaitGateBeforeSettlement(
          abortPrepared.promise,
          denied,
          "Stop settled before metadata preparation",
        ),
      );
      setUserProfileRole(aliceId, "none");
      releaseAbort.resolve();
      await expect(denied).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await wait(terminal(revokeRun.runId))).toBe("aborted");
      const revocationEffects = cancellation.mock.calls
        .filter(([, params]) => params.runId === revokeRun.runId)
        .map(([, params]) => params.diagnosticReason);
      expect(revocationEffects.length).toBeGreaterThan(0);
      // Automatic revocation cleanup owns this effect; the denied Stop never reaches it.
      expect(revocationEffects.every((reason) => reason === "authority-revoked")).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      releasePreparation.resolve();
      releaseAbort.resolve();
      prepareSend?.mockRestore();
      prepareAbort?.mockRestore();
      captureTurn.mockRestore();
      cancellation.mockRestore();
      removeNativeHarness?.();
      for (const hold of holds) {
        hold.release.resolve();
      }
      await Promise.allSettled(clients.map(disconnectGatewayClient));
      try {
        await gateway?.server.close({ reason: "initiating-person Stop proof complete" });
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
