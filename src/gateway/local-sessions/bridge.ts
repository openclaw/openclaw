// Light facade for the live local session bridge. Startup and row projection
// import this; the heavy runtime (session creation, transcript writes, node
// duplex) stays behind the `bridge.runtime.ts` lazy boundary so Gateway
// startup chunks do not absorb the whole session-creation graph.
import type { OpenClawConfig } from "../../config/config.js";
import type { LocalSessionInputRecord } from "../../config/sessions/session-local-store.js";
import type { SessionParticipantIdentity } from "../../config/sessions/session-participant-identity.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import type {
  LocalSessionInputMode,
  LocalSessionThreadState,
} from "../../sessions/local-session-source-protocol.js";
import type { LocalSessionEnrollment } from "../../state/local-session-enrollments.js";
import type { NodeSession } from "../node-registry.js";
import type { GatewayRequestContext } from "../server-methods/types.js";

export type LocalSessionSourceDescriptor = {
  pluginId: string;
  sourceId: string;
  command: string;
  label: string;
};

/** Live projection state the session row exposes; never persisted. */
export type LocalSessionStatus = {
  sourceId: string;
  sourceLabel: string;
  deviceId: string;
  threadId: string;
  ownerProfileId: string;
  ownerLabel: string;
  connected: boolean;
  state: LocalSessionThreadState;
  canInput: boolean;
  inputModes: LocalSessionInputMode[];
  reason?: string;
  earliestSeq?: number;
};

export type LocalSessionInputReceipt = {
  inputId: string;
  state: LocalSessionInputRecord["state"];
  reason?: string;
};

export type LocalSessionBridgeDeps = {
  resolveGatewayContext: () => GatewayRequestContext | undefined;
  getRuntimeConfig: () => OpenClawConfig;
  signal: AbortSignal;
};

export type LocalSessionBridge = {
  stop(): void;
  onNodeConnected(session: NodeSession): void;
  onNodeDisconnected(nodeId: string): void;
  onEnrollmentChanged(enrollment: LocalSessionEnrollment): void;
  getStatus(sessionKey: string): LocalSessionStatus | undefined;
  describeOffline(entry: SessionEntry): LocalSessionStatus | undefined;
  submitInput(params: {
    entry: SessionEntry;
    sessionKey: string;
    agentId: string;
    storePath: string;
    inputId: string;
    text: string;
    mode: LocalSessionInputMode;
    sender: { profileId?: string; displayName: string };
    participant?: SessionParticipantIdentity;
  }): Promise<LocalSessionInputReceipt>;
  unshare(params: { entry: SessionEntry; byProfileId: string }): Promise<void>;
};

/** Sources are discovered from node-host command registrations; one registration serves both ends. */
export function listRegisteredLocalSessionSources(): LocalSessionSourceDescriptor[] {
  const registry = getActivePluginRegistry();
  const sources: LocalSessionSourceDescriptor[] = [];
  for (const registration of registry?.nodeHostCommands ?? []) {
    const marker = registration.command.localSessionSource;
    if (!marker) {
      continue;
    }
    sources.push({
      pluginId: registration.pluginId,
      sourceId: marker.sourceId,
      command: registration.command.command,
      label: marker.label,
    });
  }
  return sources;
}

let activeBridge: LocalSessionBridge | undefined;
let startingBridge: Promise<LocalSessionBridge> | undefined;

/** Loads the runtime lazily; node connections that arrive first are reconciled on start. */
export function startLocalSessionBridge(deps: LocalSessionBridgeDeps): Promise<LocalSessionBridge> {
  stopLocalSessionBridge();
  const starting = import("./bridge.runtime.js").then((module) => {
    const bridge = new module.LocalSessionBridgeRuntime(deps);
    if (startingBridge === starting && !deps.signal.aborted) {
      activeBridge = bridge;
    } else {
      bridge.stop();
    }
    return bridge;
  });
  startingBridge = starting;
  starting.catch((error: unknown) => {
    console.error(`[gateway/local-sessions] bridge failed to start: ${String(error)}`);
  });
  return starting;
}

export function getLocalSessionBridge(): LocalSessionBridge | undefined {
  return activeBridge;
}

export function stopLocalSessionBridge(): void {
  activeBridge?.stop();
  activeBridge = undefined;
  startingBridge = undefined;
}
