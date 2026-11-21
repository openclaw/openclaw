import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SessionMutationTarget } from "./session-mutation-authorization-error.js";

export type SessionGroupRecord = { name: string; position: number };

export type SessionGroupDefaultsRecord = { name: string; cwd?: string; worktree?: boolean };

type SessionGroupCatalogEntry = SessionGroupRecord & {
  created_at: number;
  cwd?: string | null;
  worktree?: number | null;
};

export type SessionGroupCatalogSnapshot = {
  groups: SessionGroupRecord[];
  defaults: SessionGroupDefaultsRecord[];
  sectionOrder: string[];
};

export type SessionGroupMembershipSnapshot = {
  stores: Array<{ agentId: string; storePath: string }>;
  groups: Array<[string, SessionMutationTarget[]]>;
};

export type SessionGroupCatalogMutation =
  | { kind: "register"; name: string }
  | { kind: "put"; names: string[]; sectionOrder?: string[]; cfg: OpenClawConfig }
  | { kind: "defaults"; name: string; cwd: string | null; worktree: boolean; cfg: OpenClawConfig }
  | { kind: "prepare"; name: string; to?: string }
  | {
      kind: "retire";
      name: string;
      to?: string;
      source?: SessionGroupCatalogEntry;
      cfg: OpenClawConfig;
    };

export type SessionGroupCatalogMutationResult = {
  snapshot: SessionGroupCatalogSnapshot;
  changed: boolean;
  source?: SessionGroupCatalogEntry;
  missingName?: string;
  nonEmpty?: Array<{ name: string; memberSessions: number }>;
};
export type SessionGroupCatalogAdmission = {
  names: string[];
  groups?: Array<[string, SessionMutationTarget[]]>;
};
