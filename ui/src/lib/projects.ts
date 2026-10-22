import type { ProjectsListResult } from "../../../packages/gateway-protocol/src/index.js";
import { parseProjectGitUrl } from "../../../src/projects/project-git-url.ts";
import { gatewayPresentationScope } from "../app/gateway-presentation-scope.ts";
import type { ApplicationGateway } from "../app/gateway.ts";
import type { MarkdownGitHubRepositoryAliases } from "../components/markdown-github-repositories.ts";
import { createGatewayConnectionLifecycle } from "./gateway-connection-lifecycle.ts";
import { canCallGatewayMethod } from "./gateway-methods.ts";

type ProjectCatalogSnapshot = {
  result: ProjectsListResult | null;
  repositories: readonly MarkdownGitHubRepositoryAliases[];
  ready: boolean;
};
export type ProjectCatalog = {
  readonly snapshot: ProjectCatalogSnapshot;
  readonly loading: boolean;
  readonly pendingRead: Promise<void> | null;
  subscribe: (listener: () => void) => () => void;
  refresh: (invalidate?: boolean) => Promise<void>;
};

const catalogs = new WeakMap<ApplicationGateway, ProjectCatalog>();

/** Non-GitHub remote names are negative aliases only; they never supply link coordinates. */
function unresolvedOriginBasename(origin: string | undefined): string | undefined {
  if (!origin) {
    return undefined;
  }
  // Mirror the sanitizer's host:path forms, including bracketed IPv6 and
  // home-relative one-component paths. Local paths never supply aliases.
  const scp = /^(?![A-Za-z]:[/\\])(?:\[[^\]]+\]|[^:@/\s]+):((?!\/\/)[^\s\\]+)$/u.exec(origin);
  let pathname = scp?.[1];
  try {
    if (!pathname) {
      const url = new URL(origin);
      if (!url.hostname || url.username || url.password) {
        return undefined;
      }
      pathname = url.pathname;
    }
    const segment = pathname.split("/").findLast(Boolean);
    const name = segment
      ? decodeURIComponent(segment)
          .replace(/\.git$/iu, "")
          .trim()
      : "";
    return name && !/[/\\\p{Cc}]/u.test(name) && name !== "." && name !== ".." ? name : undefined;
  } catch {
    return undefined;
  }
}

function projectGitHubRepositories(
  projects: ProjectsListResult["projects"],
): MarkdownGitHubRepositoryAliases[] {
  return projects.map(({ displayName, originUrl }) => {
    // projects.list removes Git usernames. Restore only known default GitHub shapes,
    // never arbitrary credentials/hosts, paths, project IDs, or guessed owners.
    const origin = originUrl
      ?.replace(/^github\.com:/iu, "git@github.com:")
      .replace(/^ssh:\/\/github\.com(?::22)?\//iu, "ssh://git@github.com/");
    const parsed = origin ? parseProjectGitUrl(origin) : null;
    const [owner, repo] = parsed ? new URL(parsed.url).pathname.slice(1, -4).split("/") : [];
    if (owner && repo) {
      return { owner, repo, aliases: [displayName] };
    }
    const basename = unresolvedOriginBasename(originUrl);
    return {
      aliases:
        basename && basename.toLowerCase() !== displayName.toLowerCase()
          ? [displayName, basename]
          : [displayName],
    };
  });
}

export function projectsForGateway(gateway: ApplicationGateway): ProjectCatalog {
  const existing = catalogs.get(gateway);
  if (existing) {
    return existing;
  }
  const connection = createGatewayConnectionLifecycle(gateway.snapshot);
  const listeners = new Set<() => void>();
  let snapshot: ProjectCatalogSnapshot = { result: null, repositories: [], ready: false };
  let signature = "";
  let client = gateway.snapshot.client;
  let presentationKey = gatewayPresentationScope(gateway).key;
  let pending: Promise<void> | null = null;
  let unsubscribe: (() => void) | undefined;
  const retire = () => {
    connection.invalidate();
    pending = null;
    snapshot = { result: null, repositories: [], ready: false };
  };
  const notify = () => listeners.forEach((listener) => listener());
  const synchronize = () => {
    const next = gateway.snapshot;
    const nextPresentationKey = gatewayPresentationScope(gateway).key;
    const nextSignature =
      next.phase === "connected"
        ? JSON.stringify([
            gateway.connection.gatewayUrl,
            gateway.connectionRevision,
            nextPresentationKey,
            next.hello?.auth?.role,
            [...(next.hello?.auth?.scopes ?? [])].toSorted(),
            canCallGatewayMethod(next, "projects.list", "operator.read"),
          ])
        : signature;
    const transitioned = connection.transition(next);
    const identityChanged =
      client !== next.client ||
      nextSignature !== signature ||
      presentationKey !== nextPresentationKey;
    client = next.client;
    presentationKey = nextPresentationKey;
    if (transitioned || identityChanged) {
      signature = nextSignature;
      pending = null;
      if (identityChanged) {
        retire();
      }
      return true;
    }
    return false;
  };
  const refresh = (invalidate = false): Promise<void> => {
    synchronize();
    if (invalidate) {
      retire();
      notify();
    }
    if (pending) {
      return pending;
    }
    const scope = connection.capture();
    if (!scope) {
      return Promise.resolve();
    }
    if (!canCallGatewayMethod(gateway.snapshot, "projects.list", "operator.read")) {
      snapshot = { result: { projects: [] }, repositories: [], ready: true };
      notify();
      return Promise.resolve();
    }
    const request = scope.client
      .request<ProjectsListResult>("projects.list", {})
      .then(
        (result) => {
          synchronize();
          if (!connection.isCurrent(scope)) {
            return;
          }
          snapshot = {
            result,
            repositories: projectGitHubRepositories(result.projects),
            ready: true,
          };
        },
        () => {
          synchronize();
        },
      )
      .finally(() => {
        if (pending === request) {
          pending = null;
          notify();
        }
      });
    pending = request;
    notify();
    return request;
  };
  const catalog: ProjectCatalog = {
    get snapshot() {
      if (synchronize() && listeners.size) {
        void refresh();
      }
      return snapshot;
    },
    get loading() {
      return pending !== null;
    },
    get pendingRead() {
      return pending;
    },
    refresh,
    subscribe(listener) {
      listeners.add(listener);
      if (!unsubscribe) {
        // Gateway receipts refresh the shared authorized project catalog for New Session and cold chat.
        const unsubscribeGateway = gateway.subscribe(() => {
          if (synchronize()) {
            notify();
            void refresh();
          }
        });
        const unsubscribeEvents = gateway.subscribeEvents((event) => {
          if (event.event === "config.changed") {
            void refresh(true);
          }
        });
        unsubscribe = () => {
          unsubscribeGateway();
          unsubscribeEvents();
        };
      }
      synchronize();
      if (!snapshot.ready) {
        void refresh();
      }
      return () => {
        listeners.delete(listener);
        if (!listeners.size) {
          unsubscribe?.();
          unsubscribe = undefined;
          retire();
        }
      };
    },
  };
  catalogs.set(gateway, catalog);
  return catalog;
}
