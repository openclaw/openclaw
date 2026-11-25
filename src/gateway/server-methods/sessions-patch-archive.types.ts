import type {
  SessionCreatedActor,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { GatewaySessionStoreTargetWithStore } from "../session-utils-store.types.js";
import type { SessionLifecycleDrain } from "./sessions-lifecycle-drain.js";

export type SessionPatchArchivePreparation = {
  canonicalKey: string;
  drain: SessionLifecycleDrain;
  entry?: SessionEntry;
  releaseSource?: () => void | Promise<void>;
};

export type SessionPatchArchiveTarget = {
  archiveActor: SessionCreatedActor | undefined;
  canonicalKey: string;
  fullPatch: SessionsPatchParams;
  initialEntry?: SessionEntry;
  initialTarget: GatewaySessionStoreTargetWithStore;
  key: string;
  lifecycleIdentities: Array<string | undefined>;
  requestedAgentId?: string;
  storePath: string;
};
