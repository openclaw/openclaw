import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listProjectRegistry } from "../projects/project-registry.js";
import {
  filterProjectsForRequester,
  hasFullProjectAccess,
  type ProjectRequester,
} from "./project-access.js";
import { isSessionOwnRequester } from "./session-sharing-policy.js";

/** Who asks: the operator driving the run, or the Gateway itself for owner runs. */
export type SessionProjectRequester =
  | { profileId: string | undefined; scopes: readonly string[] }
  | undefined;

export function projectRequester(requester: SessionProjectRequester): ProjectRequester {
  return requester ? { kind: "operator", scopes: requester.scopes } : { kind: "internal" };
}

/** Registered projects this requester may move a conversation into. */
export async function listSessionProjects(cfg: OpenClawConfig, requester: SessionProjectRequester) {
  // An unbound conversation already works in its agent workspace.
  const registered = (await listProjectRegistry(cfg)).filter(
    (project) => project.source !== "workspace",
  );
  const projects = await filterProjectsForRequester(cfg, registered, projectRequester(requester));
  return projects.map(({ id, displayName, originUrl }) =>
    originUrl ? { id, name: displayName, originUrl } : { id, name: displayName },
  );
}

export function canChooseSessionProject(
  cfg: OpenClawConfig,
  sessionKey: string,
  entry: InternalSessionEntry,
  requester: SessionProjectRequester,
) {
  return (
    !requester ||
    hasFullProjectAccess(projectRequester(requester)) ||
    isSessionOwnRequester(
      { cfg, client: null },
      { canonicalKey: sessionKey, entry },
      requester.profileId,
    )
  );
}
