import { randomUUID } from "node:crypto";
// Test-audit gate: observable contract = admitted Gateway opening/recovery reaches
// real provider wire only while original operator source remains authorized.
// Credible regression = readiness resumes a revoked source and emits response.create.
// Existing tests replace provider speech callbacks; this owns actual WebSocket I/O.
// No production seams. This is NOT Android app consent, remote-provider or acoustic proof.
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import { buildOpenAIRealtimeVoiceProvider } from "../../../../extensions/openai/api.js";
import { withinTest } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { createEmptyPluginRegistry } from "../../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../../plugins/runtime.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { prepareUserProfileCatalog } from "../../../state/user-profile-list.js";
import { setUserProfileRole } from "../../../state/user-profile-writes.worker.js";
import { createOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import {
  captureGatewayDeviceRevocation,
  invalidateGatewayDeviceRevocation,
} from "../../device-revocation.js";
import { handleGatewayRequest } from "../../server-methods.js";
import {
  createContext,
  createOperatorClient,
} from "../../server-plugin-in-process-dispatch.test-support.js";
import { cleanupTalkConnection } from "../session-registry.js";
import { talkSessionHandlers } from "./session.js";

type Frame = Record<string, unknown>;
type Response = { ok: boolean; payload?: unknown; error?: { message?: string } };

async function withFixture(
  signal: AbortSignal,
  run: (fixture: {
    profileId: string;
    frames: Frame[];
    connectionCount: () => number;
    waitForFrame: (type: string) => Promise<Frame>;
    ready: () => void;
    terminal: Promise<"closed" | "speech">;
    revoke: () => void;
    dispatch: (
      method: string,
      params: Record<string, unknown>,
      foreign?: boolean,
    ) => Promise<Response>;
  }) => Promise<void>,
  assignedRole = false,
) {
  const state = await createOpenClawTestState({
    label: "talk-authority-provider-io",
    scenario: "minimal",
  });
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  const terminal = createDeferredCore<"closed" | "speech">();
  const frames: Frame[] = [];
  let connectionCount = 0;
  const waiters = new Map<string, Array<(frame: Frame) => void>>();
  let socket: WebSocket | undefined;
  let releaseDevice: (() => void) | undefined;
  let releaseCatalog: (() => void) | undefined;
  let context: ReturnType<typeof createContext> | undefined;
  let connId: string | undefined;
  try {
    server.on("connection", (candidate) => {
      connectionCount += 1;
      socket = candidate;
      candidate.once("close", () => terminal.resolve("closed"));
      candidate.on("message", (bytes) => {
        const buffer = Buffer.isBuffer(bytes)
          ? bytes
          : Array.isArray(bytes)
            ? Buffer.concat(bytes)
            : Buffer.from(bytes);
        const frame = JSON.parse(buffer.toString("utf8")) as Frame;
        frames.push(frame);
        if (frame.type === "response.create") {
          terminal.resolve("speech");
        }
        const type = String(frame.type);
        for (const resolve of waiters.get(type) ?? []) {
          resolve(frame);
        }
        waiters.delete(type);
      });
    });
    await withinTest(once(server, "listening"), signal);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("missing loopback address");
    }
    const cfg: OpenClawConfig = {
      agents: { entries: { main: { workspace: state.workspaceDir } } },
      gateway: {
        roles: {
          default: "fixtureCaller",
          definitions: {
            fixtureCaller: {
              agents: ["main"],
              scopes: ["operator.admin"],
              sessions: { others: "none" },
            },
            fixtureDenied: { agents: [], scopes: [], sessions: { others: "none" } },
          },
        },
      },
      talk: {
        agentId: "main",
        realtime: {
          provider: "openai",
          providers: {
            openai: {
              apiKey: "fixture-local", // pragma: allowlist secret
              azureEndpoint: `http://127.0.0.1:${address.port}`,
              azureDeployment: "fixture-realtime",
            },
          },
        },
      },
    };
    await state.writeConfig(cfg);
    const registry = createEmptyPluginRegistry();
    registry.realtimeVoiceProviders.push({
      pluginId: "openai",
      source: "test",
      provider: buildOpenAIRealtimeVoiceProvider(),
    });
    setActivePluginRegistry(registry);
    context = createContext();
    context.getRuntimeConfig = () => cfg;
    context.chatAbortControllers = new Map();
    context.getClientConnIds = () => new Set([connId!]);
    context.broadcastToConnIds = () => {};
    context.resolveGatewayContext = () => context!;
    const client = createOperatorClient({
      profileName: "loopback-owner",
      scopes: ["operator.admin"],
    });
    const profileId = client.authenticatedUserProfile!.profileId;
    if (assignedRole) {
      setUserProfileRole(profileId, "fixtureCaller");
    }
    connId = client.connId;
    const foreign = createOperatorClient({
      profileName: "loopback-foreign",
      scopes: ["operator.admin"],
    });
    releaseCatalog = (await prepareUserProfileCatalog()).release;
    const connection = new AbortController();
    const deviceId = randomUUID();
    const device = captureGatewayDeviceRevocation(
      context,
      { deviceId, role: "operator" },
      () => !connection.signal.aborted,
      connection.signal,
    );
    releaseDevice = device.release;
    await run({
      profileId,
      frames,
      connectionCount: () => connectionCount,
      waitForFrame: async (type) => {
        const existing = frames.find((frame) => frame.type === type);
        if (existing) {
          return existing;
        }
        return withinTest(
          new Promise<Frame>((resolve) => {
            waiters.set(type, [...(waiters.get(type) ?? []), resolve]);
          }),
          signal,
        );
      },
      ready: () => {
        if (!socket) {
          throw new Error("provider not connected");
        }
        socket.send(JSON.stringify({ type: "session.updated" }));
      },
      terminal: terminal.promise,
      revoke: () => invalidateGatewayDeviceRevocation(context!, deviceId, "operator"),
      dispatch: async (method, params, useForeign = false) => {
        let result: Response | undefined;
        await handleGatewayRequest({
          req: { type: "req", id: randomUUID(), method, params },
          client: useForeign ? foreign : client,
          context: context!,
          isWebchatConnect: () => false,
          hasCurrentClientAuthority: useForeign ? undefined : device.isCurrent,
          respond: (ok, payload, error) => {
            result = { ok, payload, error };
          },
          extraHandlers: talkSessionHandlers,
        });
        if (!result) {
          throw new Error("registered handler did not respond");
        }
        return result;
      },
    });
  } finally {
    if (connId && context) {
      cleanupTalkConnection(connId, context.logGateway);
    }
    releaseDevice?.();
    releaseCatalog?.();
    for (const client of server.clients) {
      client.terminate();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
    restoreActivePluginRegistrySnapshot(registrySnapshot);
    await state.cleanup();
  }
}

const createParams = {
  sessionKey: "agent:main:loopback-authority",
  mode: "realtime",
  transport: "gateway-relay",
  brain: "agent-consult",
  provider: "openai",
};

function sessionId(result: Response): string {
  expect(result.error?.message).toBeUndefined();
  expect(result.ok).toBe(true);
  const id = (result.payload as { sessionId?: unknown })?.sessionId;
  expect(typeof id).toBe("string");
  return id as string;
}

describe("registered Talk authority at real loopback provider I/O", () => {
  it("rejects a denied role before opening provider transport", async ({ signal }) => {
    await withFixture(signal, async (fixture) => {
      setUserProfileRole(fixture.profileId, "fixtureDenied");
      const rejected = await fixture.dispatch("talk.session.create", {
        ...createParams,
        greeting: "Fixture opening",
      });
      expect(rejected.ok).toBe(false);
      expect(rejected.error?.message).toContain("operator role changed");
      expect(fixture.connectionCount()).toBe(0);
      expect(fixture.frames).toHaveLength(0);
    });
  });

  it("delivers authorized PCM/opening but rejects another principal before provider I/O", async ({
    signal,
  }) => {
    await withFixture(signal, async (fixture) => {
      const id = sessionId(
        await fixture.dispatch("talk.session.create", {
          ...createParams,
          greeting: "Fixture opening",
        }),
      );
      await fixture.waitForFrame("session.update");
      const foreign = await fixture.dispatch(
        "talk.session.appendAudio",
        { sessionId: id, audioBase64: "AQI=" },
        true,
      );
      expect(foreign.ok).toBe(false);
      expect(
        fixture.frames.filter((frame) => frame.type === "input_audio_buffer.append"),
      ).toHaveLength(0);
      fixture.ready();
      const appended = await fixture.dispatch("talk.session.appendAudio", {
        sessionId: id,
        audioBase64: "AQI=",
      });
      expect(appended.ok).toBe(true);
      expect(await withinTest(fixture.terminal, signal)).toBe("speech");
      const pcm = await fixture.waitForFrame("input_audio_buffer.append");
      expect(Buffer.from(String(pcm.audio), "base64")).toEqual(Buffer.from([1, 2]));
      await fixture.waitForFrame("response.create");
    });
  });

  it.for(["opening", "recovery"] as const)(
    "does not emit %s speech when retained device authority is revoked during provider startup",
    async (kind, { signal }) => {
      await withFixture(signal, async (fixture) => {
        const id = sessionId(
          await fixture.dispatch("talk.session.create", {
            ...createParams,
            ...(kind === "opening"
              ? { greeting: "Fixture opening" }
              : { recovery: { interruptedForMs: 12_000 } }),
          }),
        );
        await fixture.waitForFrame("session.update");
        // This admitted silent frame establishes client readiness before revocation.
        expect(
          (
            await fixture.dispatch("talk.session.appendAudio", {
              sessionId: id,
              audioBase64: "AAA=",
            })
          ).ok,
        ).toBe(true);
        fixture.revoke();
        fixture.ready();
        // Fail-session closes actual provider transport; its close is the terminal
        // barrier proving all earlier ordered outbound frames have been observed.
        // Unauthorized speech settles first and fails immediately, rather than timing out.
        expect(await withinTest(fixture.terminal, signal)).toBe("closed");
        expect(fixture.frames.filter((frame) => frame.type === "response.create")).toHaveLength(0);
      });
    },
  );

  it("does not emit delayed opening after a committed profile role reassignment", async ({
    signal,
  }) => {
    await withFixture(
      signal,
      async (fixture) => {
        const id = sessionId(
          await fixture.dispatch("talk.session.create", {
            ...createParams,
            greeting: "Fixture opening",
          }),
        );
        await fixture.waitForFrame("session.update");
        expect(
          (
            await fixture.dispatch("talk.session.appendAudio", {
              sessionId: id,
              audioBase64: "AAA=",
            })
          ).ok,
        ).toBe(true);
        // Real worker writer commits assignment and publishes authority invalidation.
        // It does not edit the authenticated transport principal or its scope snapshot.
        setUserProfileRole(fixture.profileId, "fixtureDenied");
        fixture.ready();
        expect(await withinTest(fixture.terminal, signal)).toBe("closed");
        expect(fixture.frames.filter((frame) => frame.type === "response.create")).toHaveLength(0);
      },
      true,
    );
  });
});
