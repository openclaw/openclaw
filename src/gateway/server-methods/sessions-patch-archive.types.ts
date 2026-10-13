import type {
  SessionCreatedActor,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { SessionLifecycleDrain } from "./sessions-lifecycle-drain.js";

export type SessionPatchArchivePreparation = {
  canonicalKey: string;
  drain: SessionLifecycleDrain;
  entry?: SessionEntry;
};

export type SessionPatchArchiveTarget = {
  archiveActor: SessionCreatedActor | undefined;
  canonicalKey: string;
  fullPatch: SessionsPatchParams;
  initialEntry?: SessionEntry;
  initialStoreKeys: string[];
  key: string;
  lifecycleIdentities: Array<string | undefined>;
  requestedAgentId?: string;
  storePath: string;
};
