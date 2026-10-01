// Gateway-owned custom session group catalog.
// Membership stays on each session entry's category field; this module owns
// which groups exist, their display order, and bulk member category updates.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { updateSessionGroupCategoriesInWorker } from "../config/sessions/session-group-categories.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  ensureSessionGroupCatalog,
  mutateSessionGroupCatalog,
  readSessionGroupCatalog,
  readSessionGroupMembershipInWorker,
} from "./session-group-catalog.js";
import type {
  SessionGroupDefaultsRecord,
  SessionGroupRecord,
} from "./session-group-catalog.types.js";
import {
  SessionMutationAuthorizationChangedError,
  type SessionMutationTarget,
} from "./session-mutation-authorization-error.js";

export class SessionGroupNotFoundError extends Error {
  constructor(name: string) {
    super(`unknown session group: ${name}`);
    this.name = "SessionGroupNotFoundError";
  }
}

export class SessionGroupNotEmptyError extends Error {
  constructor(readonly groups: ReadonlyArray<{ name: string; memberSessions: number }>) {
    super(
      `sessions.groups.put cannot drop groups that still have member sessions: ${groups
        .map((group) => `"${group.name}" (${group.memberSessions})`)
        .join(", ")}; include them in names or remove them via sessions.groups.delete`,
    );
    this.name = "SessionGroupNotEmptyError";
  }
}

function normalizeSidebarSectionOrder(
  sectionOrder: readonly string[],
  groupNames: readonly string[],
): string[] {
  const groups = new Set(groupNames);
  const normalized = new Set<string>();
  for (const raw of sectionOrder) {
    const sectionId = raw.trim();
    let canonical: string | null = null;
    if (sectionId === "ungrouped" || sectionId === "groups" || sectionId === "work") {
      canonical = sectionId;
    } else if (sectionId.startsWith("category:")) {
      const name = normalizeOptionalString(sectionId.slice("category:".length));
      if (name && groups.has(name)) {
        canonical = `category:${name}`;
      }
    } else if (sectionId.startsWith("catalog:")) {
      const catalogId = normalizeOptionalString(sectionId.slice("catalog:".length));
      if (catalogId) {
        canonical = `catalog:${catalogId}`;
      }
    }
    if (canonical) {
      normalized.add(canonical);
    }
  }
  return [...normalized];
}

export function listSessionGroups(env: NodeJS.ProcessEnv = process.env): SessionGroupRecord[] {
  return readSessionGroupCatalog(env).groups;
}

export function listSessionGroupDefaults(
  env: NodeJS.ProcessEnv = process.env,
): SessionGroupDefaultsRecord[] {
  return readSessionGroupCatalog(env).defaults;
}

export function listSidebarSectionOrder(env: NodeJS.ProcessEnv = process.env): string[] {
  return readSessionGroupCatalog(env).sectionOrder;
}

/**
 * Replaces the ordered catalog. Dropping a name whose group still has member
 * sessions is rejected: member sweeps stay owned by sessions.groups.delete,
 * so a put can never leave dangling categories that resurrect the group.
 */
export async function putSessionGroups(params: {
  cfg: OpenClawConfig;
  names: readonly string[];
  sectionOrder?: readonly string[];
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId?: string; sessionKey: string }) => void;
}): Promise<SessionGroupRecord[]> {
  const { cfg, names, sectionOrder, env = process.env } = params;
  await ensureSessionGroupCatalog(env);
  const normalized = normalizeUniqueTrimmedStringList(names);
  const normalizedSectionOrder =
    sectionOrder === undefined ? undefined : normalizeSidebarSectionOrder(sectionOrder, normalized);
  const result = await mutateSessionGroupCatalog(
    {
      kind: "put",
      names: normalized,
      sectionOrder: normalizedSectionOrder,
      cfg: { agents: cfg.agents, session: cfg.session },
    },
    env,
    (facts) => {
      params.assertCurrent?.();
      for (const [, targets] of facts?.groups ?? []) {
        for (const target of targets) {
          params.assertTargetCurrent?.(target);
        }
      }
    },
  );
  if (result.nonEmpty?.length) {
    throw new SessionGroupNotEmptyError(result.nonEmpty);
  }
  return result.snapshot.groups;
}

/**
 * Absorbs a category assigned through sessions.patch so the catalog keeps
 * covering every group an operator UI can observe, appended at the end.
 */
export async function ensureSessionGroupRegistered(
  name: string,
  env: NodeJS.ProcessEnv = process.env,
  assertCurrent?: () => void,
): Promise<boolean> {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    return false;
  }
  return (
    await mutateSessionGroupCatalog({ kind: "register", name: normalized }, env, assertCurrent)
  ).changed;
}

export async function updateSessionGroupDefaults(
  name: string,
  defaults: { cwd: string | null; worktree: boolean },
  env: NodeJS.ProcessEnv = process.env,
  assertCurrent?: (targets?: readonly SessionMutationTarget[]) => void,
  cfg: OpenClawConfig = {},
): Promise<SessionGroupDefaultsRecord[] | null> {
  const normalized = normalizeOptionalString(name);
  if (!normalized) {
    throw new Error("group defaults update requires a non-empty name");
  }
  const result = await mutateSessionGroupCatalog(
    {
      kind: "defaults",
      cfg: { agents: cfg.agents, session: cfg.session },
      name: normalized,
      cwd: normalizeOptionalString(defaults.cwd) ?? null,
      worktree: defaults.worktree,
    },
    env,
    (facts) => assertCurrent?.(facts?.groups?.find(([group]) => group === normalized)?.[1]),
  );
  return result.changed ? result.snapshot.defaults : null;
}

/**
 * Bulk-updates member session categories across every agent store without
 * bumping updatedAt: group maintenance must not reshuffle recency ordering.
 */
async function updateMemberCategories(
  cfg: OpenClawConfig,
  from: string,
  to: string | undefined,
  env: NodeJS.ProcessEnv,
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void,
): Promise<number> {
  let updated = 0;
  const { stores } = await readSessionGroupMembershipInWorker(cfg, env);
  for (const target of stores) {
    updated += await updateSessionGroupCategoriesInWorker({
      scope: { ...target, sessionKey: "", env },
      from,
      to,
      assertTargetCurrent,
    });
  }
  return updated;
}

type SessionGroupMutationParams = {
  cfg: OpenClawConfig;
  name: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent?: () => void;
  assertTargetCurrent?: (target: { agentId: string; sessionKey: string }) => void;
};

async function mutateSessionGroup(
  params: SessionGroupMutationParams & { to?: string },
  action: "rename" | "delete",
): Promise<{ groups: SessionGroupRecord[]; sectionOrder: string[]; updatedSessions: number }> {
  const env = params.env ?? process.env;
  await ensureSessionGroupCatalog(env);
  const from = normalizeOptionalString(params.name);
  const to = action === "rename" ? normalizeOptionalString(params.to) : undefined;
  if (!from || (action === "rename" && !to)) {
    throw new Error(
      action === "rename"
        ? "group rename requires non-empty names"
        : "group delete requires a non-empty name",
    );
  }
  let updatedSessions = 0;
  if (from !== to) {
    params.assertCurrent?.();
    const prepared = await mutateSessionGroupCatalog(
      { kind: "prepare", name: from, to },
      env,
      params.assertCurrent,
    );
    if (prepared.missingName) {
      throw new SessionGroupNotFoundError(prepared.missingName);
    }
    const source = prepared.source;
    try {
      updatedSessions = await updateMemberCategories(
        params.cfg,
        from,
        to,
        env,
        params.assertTargetCurrent,
      );
      params.assertCurrent?.();
      // The state worker rereads all stores in the retirement transaction so late assignments retain the source.
      const retired = await mutateSessionGroupCatalog(
        {
          kind: "retire",
          name: from,
          to,
          source,
          cfg: { agents: params.cfg.agents, session: params.cfg.session },
        },
        env,
        params.assertCurrent,
      );
      if (retired.missingName) {
        throw new SessionGroupNotFoundError(retired.missingName);
      }
    } catch (error) {
      const message = `${formatErrorMessage(error)}. Group changes may be partial; reload groups and retry the same operation.`;
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw new SessionMutationAuthorizationChangedError({ ...error.error, message });
      }
      throw new Error(message, { cause: error });
    }
  }
  return {
    groups: listSessionGroups(env),
    sectionOrder: listSidebarSectionOrder(env),
    updatedSessions,
  };
}

export async function renameSessionGroup(params: SessionGroupMutationParams & { to: string }) {
  return await mutateSessionGroup(params, "rename");
}

export async function deleteSessionGroup(params: SessionGroupMutationParams) {
  return await mutateSessionGroup(params, "delete");
}
