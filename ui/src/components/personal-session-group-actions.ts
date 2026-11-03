import type { GatewaySessionRow, SessionsListResult } from "../api/types.ts";
import type { ApplicationContext } from "../app/context.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import { prefValuesEqual } from "../app/server-prefs-state.ts";
import { t } from "../i18n/index.ts";
import { projectsForGateway } from "../lib/projects.ts";
import { resolveSessionDisplayName } from "../lib/session-display.ts";
import {
  normalizePersonalSessionGroups,
  type PersonalSessionGroup,
  type PersonalSessionGroupCandidate,
  type PersonalSessionGroupPage,
  type PersonalSessionGroupScope,
} from "../lib/sessions/personal-groups.ts";
import { isPinnableUiSessionRow, parseAgentSessionKey } from "../lib/sessions/session-key.ts";
import { buildSessionListParams, SESSION_SEARCH_SCOPE } from "../lib/sessions/session-requests.ts";
import { showToast } from "../lib/toast.ts";
import { showPersonalSessionGroupDialog } from "./personal-session-group-dialog.tsx";

const SECTION_CANDIDATE_LIMIT = 100;

export function personalSessionGroupCandidate(
  row: GatewaySessionRow,
  viewerId?: string,
): PersonalSessionGroupCandidate {
  const actor = row.owner?.actor;
  const ownerId = actor?.identity?.id ?? actor?.id;
  return {
    key: row.key,
    label: resolveSessionDisplayName(row.key, row),
    pinnable: isPinnableUiSessionRow(row),
    archived: row.archived,
    ...(actor && ownerId && ownerId !== viewerId
      ? {
          ownedBy: {
            id: ownerId,
            label: actor.label,
            avatarUrl: actor.avatarUrl,
            identity: actor.identity,
          },
        }
      : {}),
  };
}

export function personalSessionGroupCandidates(
  context: ApplicationContext,
): PersonalSessionGroupCandidate[] {
  return context.sessions.canonicalListReady
    ? (context.sessions.state.result?.sessions ?? []).map((row) =>
        personalSessionGroupCandidate(row),
      )
    : [];
}

/** All entry points edit the same personal preference; no session mutation is involved. */
export function createPersonalSessionGroupActions(
  context: ApplicationContext,
  candidates: () => readonly PersonalSessionGroupCandidate[] = () =>
    personalSessionGroupCandidates(context),
  resolve: (key: string) => PersonalSessionGroupCandidate | undefined = (key) =>
    candidates().find((row) => row.key === key),
  lifetimeSignal?: AbortSignal,
) {
  const groups = () => context.navigation.snapshot.personalSessionGroups ?? [];
  const viewerId = () => gatewayPresentationScope(context.gateway).displayUser?.id;
  const write = (next: readonly PersonalSessionGroup[]): string | null => {
    // The profile preference has a byte limit. Never silently truncate an authored layout.
    if (!prefValuesEqual(normalizePersonalSessionGroups(next), next)) {
      return t("sessionsView.personalGroupCapacity");
    }
    context.navigation.update({ personalSessionGroups: next });
    return null;
  };
  // A selected row may live only in an access-scoped descriptor, not the current list page.
  // Keep that owner's observation alive across menu dismissal and the collection dialog.
  const withTarget = async (
    selectedKey: string | undefined,
    selectedAgentId: string | undefined,
    run: (target: {
      current: () => boolean;
      eligible: (key: string) => boolean | undefined;
      available: readonly PersonalSessionGroupCandidate[];
      signal: AbortSignal;
    }) => void | Promise<void>,
  ) => {
    const scope = context.sessions.captureConnectionScope();
    if (!scope) {
      return;
    }
    const current = () => context.sessions.isConnectionScopeCurrent(scope);
    const controller = new AbortController();
    const stop = context.gateway.subscribe(() => {
      if (!current()) {
        controller.abort();
      }
    });
    const target = selectedKey
      ? {
          key: selectedKey,
          agentId:
            selectedAgentId ??
            parseAgentSessionKey(selectedKey)?.agentId ??
            context.agentSelection.state.selectedId ??
            "main",
        }
      : undefined;
    const observation = target ? context.sessions.observeRow(target, () => {}) : undefined;
    const selected = () =>
      observation?.isCurrent() && observation.row
        ? personalSessionGroupCandidate(observation.row)
        : undefined;
    const eligible = (key: string) => {
      const row = key === selectedKey ? selected() : resolve(key);
      return row?.pinnable && !row.archived;
    };
    try {
      if (!current()) {
        return;
      }
      if (target && observation && !observation.row) {
        const reconcile = observation.captureReconcile();
        const result = await context.sessions.describe(target);
        if (!current()) {
          return;
        }
        reconcile(result.session ?? undefined);
      }
      if (selectedKey && !eligible(selectedKey)) {
        showToast({ message: t("sessionsView.personalGroupUnavailable") });
        return;
      }
      const available = candidates().filter((row) => row.pinnable && !row.archived);
      const row = selected();
      if (row && !available.some((candidate) => candidate.key === row.key)) {
        available.push(row);
      }
      await run({
        current,
        eligible,
        available,
        signal: lifetimeSignal
          ? AbortSignal.any([controller.signal, lifetimeSignal])
          : controller.signal,
      });
    } catch {
      showToast({ message: t("sessionsView.actionUnavailable") });
    } finally {
      observation?.dispose();
      stop();
    }
  };
  const edit = (id?: string, selectedKey?: string, selectedAgentId?: string) =>
    withTarget(selectedKey, selectedAgentId, async ({ current, eligible, available, signal }) => {
      const group = id ? groups().find((item) => item.id === id) : undefined;
      if (id && !group) {
        return;
      }
      // Rows returned by the scoped query join the loaded list as eligible members.
      const fetched = new Map<string, PersonalSessionGroupCandidate>();
      const known = new Map(available.map((row) => [row.key, row]));
      for (const key of group?.sessionKeys ?? []) {
        const row = known.has(key) ? undefined : resolve(key);
        if (row?.pinnable && !row.archived) {
          known.set(key, row);
        }
      }
      const client = context.gateway.snapshot.client;
      const viewer = viewerId();
      const projects = projectsForGateway(context.gateway);
      // The catalog is per Gateway; only the first editor open waits for it.
      if (!projects.snapshot.ready) {
        await projects.refresh();
      }
      const load = async (
        scope: PersonalSessionGroupScope,
        search: string,
      ): Promise<PersonalSessionGroupPage | null> => {
        if (!client || !current()) {
          return null;
        }
        // The Gateway applies the viewer's access to every scope; the editor only narrows it.
        // A plain request keeps per-keystroke queries out of the sidebar's conditional row cache.
        const result = await client.request<SessionsListResult | undefined>("sessions.list", {
          ...buildSessionListParams({
            ...SESSION_SEARCH_SCOPE,
            limit: SECTION_CANDIDATE_LIMIT,
            search,
            ...(scope.kind === "mine" && viewer ? { ownerId: viewer } : {}),
            ...(scope.kind === "involving" ? { involvingMe: true } : {}),
          }),
          ...(scope.kind === "project" ? { projectId: scope.projectId } : {}),
        });
        if (!result || !current()) {
          return null;
        }
        const sessions = result.sessions
          .map((row) => personalSessionGroupCandidate(row, viewer))
          .filter((row) => row.pinnable && !row.archived);
        for (const row of sessions) {
          fetched.set(row.key, row);
        }
        return { sessions, hasMore: result.hasMore === true };
      };
      await showPersonalSessionGroupDialog({
        group,
        known: [...known.values()],
        selectedKey,
        scopes: {
          personal: Boolean(viewer),
          projects: (projects.snapshot.result?.projects ?? []).map((project) => ({
            id: project.id,
            label: project.displayName,
          })),
        },
        load,
        signal,
        submit: (value) => {
          const saved = id ? groups().find((item) => item.id === id) : undefined;
          if (!current() || (id && !saved)) {
            return t("sessionsView.personalGroupUnavailable");
          }
          if (id && !prefValuesEqual(saved, group)) {
            return t("sessionsView.personalGroupChanged");
          }
          // Retain unresolved saved references, but new membership must still resolve.
          const previousKeys = new Set(group?.sessionKeys);
          const next = {
            ...value,
            id: id ?? crypto.randomUUID(),
            sessionKeys: value.sessionKeys.filter(
              (key) => previousKeys.has(key) || fetched.has(key) || eligible(key),
            ),
          };
          return write(
            id ? groups().map((item) => (item.id === id ? next : item)) : [...groups(), next],
          );
        },
      });
    });
  const add = (id: string, key: string, selectedAgentId?: string) =>
    withTarget(key, selectedAgentId, ({ current }) => {
      const group = groups().find((item) => item.id === id);
      if (!current() || !group || group.sessionKeys.includes(key)) {
        return;
      }
      const updated = { ...group, sessionKeys: [...group.sessionKeys, key] };
      const error = write(groups().map((item) => (item.id === id ? updated : item)));
      showToast({ message: error ?? t("sessionsView.personalGroupReferenceAdded") });
    });
  return { write, edit, add };
}
