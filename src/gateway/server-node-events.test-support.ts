import { vi } from "vitest";
import { WebSocket } from "ws";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.js";
import type { DurableMessageBatchSendResult } from "../channels/message/runtime.js";
import type { OpenClawConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeLegacySessionEntryDelivery } from "../infra/state-migrations.legacy-session-store.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import type { GatewayWsClient } from "./server/ws-types.js";
import type { loadSessionEntry as loadSessionEntryType } from "./session-utils.js";

export const buildSessionLookup = (
  sessionKey: string,
  entry: {
    agentHarnessId?: string;
    modelSelectionLocked?: boolean;
    sessionId?: string;
    model?: string;
    modelProvider?: string;
    lastChannel?: string;
    lastTo?: string;
    lastAccountId?: string;
    lastThreadId?: string | number;
    updatedAt?: number;
    label?: string;
    spawnedBy?: string;
    parentSessionKey?: string;
  } = {},
): ReturnType<typeof loadSessionEntryType> => ({
  cfg: { session: { mainKey: "agent:main:main" } } as OpenClawConfig,
  agentId: resolveAgentIdFromSessionKey(sessionKey, "main"),
  storePath: "/tmp/sessions.json",
  store: {} as ReturnType<typeof loadSessionEntryType>["store"],
  entry: {
    agentHarnessId: entry.agentHarnessId,
    modelSelectionLocked: entry.modelSelectionLocked,
    sessionId: entry.sessionId ?? `sid-${sessionKey}`,
    updatedAt: entry.updatedAt ?? Date.now(),
    model: entry.model,
    modelProvider: entry.modelProvider,
    delivery: normalizeLegacySessionEntryDelivery({
      ...entry,
      sessionId: entry.sessionId ?? `sid-${sessionKey}`,
      updatedAt: entry.updatedAt ?? Date.now(),
    } as SessionEntry).delivery,
    label: entry.label,
    spawnedBy: entry.spawnedBy,
    parentSessionKey: entry.parentSessionKey,
  },
  canonicalKey: sessionKey,
  storeKeys: [sessionKey],
  legacyKey: undefined,
});

const ingressAgentCommandMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const registerApnsRegistrationMock = vi.hoisted(() => vi.fn());
const loadOrCreateProcessDeviceIdentityMock = vi.hoisted(() =>
  vi.fn(() => ({
    deviceId: "gateway-device-1",
    publicKeyPem: "public",
    privateKeyPem: "private",
  })),
);
const parseMessageWithAttachmentsMock = vi.hoisted(() => vi.fn());
const persistInboundImagesForTranscriptMock = vi.hoisted(() => vi.fn());
const normalizeChannelIdMock = vi.hoisted(() =>
  vi.fn((channel?: string | null) => channel ?? null),
);
const updatePairedDevicePresenceMock = vi.hoisted(() => vi.fn().mockResolvedValue(true));

const runtimeMocks = vi.hoisted(() => ({
  agentCommandFromIngress: ingressAgentCommandMock,
  ApnsRegistrationPairingChangedError: class ApnsRegistrationPairingChangedError extends Error {
    constructor() {
      super("node pairing changed before APNs registration");
      this.name = "ApnsRegistrationPairingChangedError";
    }
  },
  deleteMediaBuffer: vi.fn(async () => {}),
  deliverOutboundPayloads: vi.fn(async () => {}),
  enqueueSystemEvent: vi.fn(),
  formatForLog: vi.fn((err: unknown) => (err instanceof Error ? err.message : String(err))),
  getRuntimeConfig: vi.fn(() => ({ session: { mainKey: "agent:main:main" } })),
  INLINE_IMAGE_DURABLE_OMISSION_MARKER:
    "[image attachment omitted: durable managed media claim unavailable]",
  loadOrCreateProcessDeviceIdentity: loadOrCreateProcessDeviceIdentityMock,
  loadSessionEntry: vi.fn((sessionKey: string) => buildSessionLookup(sessionKey)),
  upsertSessionEntryCore: vi.fn(),
  normalizeChannelId: normalizeChannelIdMock,
  normalizeMainKey: vi.fn((key?: string | null) => key?.trim() || "agent:main:main"),
  parseMessageWithAttachments: parseMessageWithAttachmentsMock,
  registerApnsRegistration: registerApnsRegistrationMock,
  requestHeartbeat: vi.fn(),
  resolveSystemMainSessionTarget: vi.fn(() => ({
    agentId: "ops",
    sessionKey: "agent:ops:main",
  })),
  resolveChatAttachmentMaxBytes: vi.fn(() => 20 * 1024 * 1024),
  resolveGatewayModelSupportsImages: vi.fn(
    async ({
      loadGatewayModelCatalog,
      provider,
      model,
    }: {
      loadGatewayModelCatalog: () => Promise<
        Array<{ id: string; provider: string; input?: string[] }>
      >;
      provider?: string;
      model?: string;
    }) => {
      if (!model) {
        return true;
      }
      const catalog = await loadGatewayModelCatalog();
      const modelEntry = catalog.find(
        (entry) => entry.id === model && (!provider || entry.provider === provider),
      );
      return modelEntry ? (modelEntry.input?.includes("image") ?? false) : true;
    },
  ),
  sendDurableMessageBatch: vi.fn(async (): Promise<DurableMessageBatchSendResult> => ({
    status: "sent",
    results: [],
    receipt: { platformMessageIds: [], parts: [], sentAt: 1 },
  })),
  resolveSessionAgentId: vi.fn(() => "main"),
  resolveSessionModelRef: vi.fn(
    (_cfg: OpenClawConfig, entry?: { model?: string; modelProvider?: string }) => ({
      provider: entry?.modelProvider ?? "test-provider",
      model: entry?.model ?? "default-model",
    }),
  ),
  persistInboundImagesForTranscript: persistInboundImagesForTranscriptMock,
}));

vi.mock("../agents/agent-scope.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/agent-scope.js")>()),
  resolveSessionAgentId: runtimeMocks.resolveSessionAgentId,
}));

vi.mock("../channels/message/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/message/runtime.js")>()),
  sendDurableMessageBatchCore: runtimeMocks.sendDurableMessageBatch,
}));

vi.mock("../channels/plugins/index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/index.js")>()),
  normalizeChannelId: runtimeMocks.normalizeChannelId,
}));

vi.mock("../commands/agent.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/agent.js")>()),
  agentCommandFromIngress: runtimeMocks.agentCommandFromIngress,
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: runtimeMocks.getRuntimeConfig,
}));

vi.mock("../config/sessions/main-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/main-session.js")>()),
  resolveSystemMainSessionTarget: runtimeMocks.resolveSystemMainSessionTarget,
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/sessions/session-accessor.js")>()),
  upsertSessionEntryCore: runtimeMocks.upsertSessionEntryCore,
}));

vi.mock("../infra/device-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-identity.js")>()),
  loadOrCreateProcessDeviceIdentity: runtimeMocks.loadOrCreateProcessDeviceIdentity,
}));

vi.mock("../infra/device-pairing.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing.js")>()),
  updatePairedDevicePresence: updatePairedDevicePresenceMock,
}));

vi.mock("../infra/heartbeat-wake.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/heartbeat-wake.js")>()),
  requestHeartbeat: runtimeMocks.requestHeartbeat,
}));

vi.mock("../infra/push-apns.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/push-apns.js")>()),
  ApnsRegistrationPairingChangedError: runtimeMocks.ApnsRegistrationPairingChangedError,
  registerApnsRegistration: runtimeMocks.registerApnsRegistration,
}));

vi.mock("../infra/system-events.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/system-events.js")>()),
  enqueueSystemEvent: runtimeMocks.enqueueSystemEvent,
}));

vi.mock("../media/store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../media/store.js")>()),
  deleteMediaBuffer: runtimeMocks.deleteMediaBuffer,
}));

vi.mock("../routing/session-key.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../routing/session-key.js")>()),
  normalizeMainKey: runtimeMocks.normalizeMainKey,
}));

vi.mock("./chat-attachment-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-attachment-policy.js")>()),
  resolveChatAttachmentMaxBytes: runtimeMocks.resolveChatAttachmentMaxBytes,
}));

vi.mock("./chat-attachments.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./chat-attachments.js")>()),
  INLINE_IMAGE_DURABLE_OMISSION_MARKER: runtimeMocks.INLINE_IMAGE_DURABLE_OMISSION_MARKER,
  parseMessageWithAttachments: runtimeMocks.parseMessageWithAttachments,
  persistInboundImagesForTranscript: runtimeMocks.persistInboundImagesForTranscript,
}));

vi.mock("./session-utils.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./session-utils.js")>()),
  loadSessionEntry: runtimeMocks.loadSessionEntry,
  resolveGatewayModelSupportsImages: runtimeMocks.resolveGatewayModelSupportsImages,
  resolveSessionModelRef: runtimeMocks.resolveSessionModelRef,
}));

vi.mock("./ws-log.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ws-log.js")>()),
  formatForLog: runtimeMocks.formatForLog,
}));

export {
  loadOrCreateProcessDeviceIdentityMock,
  parseMessageWithAttachmentsMock,
  persistInboundImagesForTranscriptMock,
  updatePairedDevicePresenceMock,
  runtimeMocks,
};

export function makeNodeClient(connId: string, nodeId: string): GatewayWsClient {
  return {
    connId,
    usesSharedGatewayAuth: false,
    socket: {
      readyState: WebSocket.OPEN,
      send: () => {},
    } as unknown as GatewayWsClient["socket"],
    connect: {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "node-host",
        version: "1.0.0",
        platform: "linux",
        mode: "node",
      },
      device: {
        id: nodeId,
        publicKey: "public-key",
        signature: "signature",
        signedAt: 1,
        nonce: "nonce",
      },
    } as GatewayWsClient["connect"],
  };
}
