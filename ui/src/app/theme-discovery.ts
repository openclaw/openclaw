import type {
  ThemesBrowseResult,
  ThemesMutationResult,
} from "../../../packages/gateway-protocol/src/schema/themes.ts";
import { createChangeListeners } from "../../../src/shared/listeners.js";
import type { ApplicationGateway } from "./gateway.ts";

type DiscoverySnapshot = {
  page: ThemesBrowseResult | null;
  query: string;
  loading: boolean;
  mutation: string | null;
  error: string | null;
  saved: string | null;
};

/** Appearance owns this optional read; the general plugin catalogue never requests it. */
export function createThemeDiscovery(gateway: ApplicationGateway, refreshInstalled: () => void) {
  const listeners = createChangeListeners();
  let snapshot: DiscoverySnapshot = {
    page: null,
    query: "",
    loading: false,
    mutation: null,
    error: null,
    saved: null,
  };
  let generation = 0;
  let scopeGeneration = 0;
  let disposed = false;
  const capture = () => ({
    client: gateway.snapshot.client,
    profile: gateway.snapshot.selfUser?.id,
    url: gateway.connection.gatewayUrl,
  });
  let scope = capture();
  const current = (captured: ReturnType<typeof capture>) =>
    !disposed &&
    gateway.snapshot.phase === "connected" &&
    gateway.snapshot.client === captured.client &&
    gateway.snapshot.selfUser?.id === captured.profile &&
    gateway.connection.gatewayUrl === captured.url;
  const publish = (patch: Partial<DiscoverySnapshot>) => {
    snapshot = { ...snapshot, ...patch };
    listeners.publish();
  };
  const unsubscribe = gateway.subscribe(() => {
    const next = capture();
    if (
      !current(scope) ||
      next.client !== scope.client ||
      next.profile !== scope.profile ||
      next.url !== scope.url
    ) {
      generation++;
      scopeGeneration++;
      scope = next;
      publish({ page: null, loading: false, mutation: null, error: null, saved: null });
    }
  });

  return {
    get snapshot() {
      return snapshot;
    },
    subscribe: listeners.subscribe,
    async browse(query = "", cursor?: string) {
      const captured = capture();
      const attempt = ++generation;
      publish({ loading: true, query, error: null, saved: null });
      try {
        if (!current(captured) || !captured.client) {
          throw new Error("Connect to browse themes.");
        }
        const page = await captured.client.request<ThemesBrowseResult>("themes.browse", {
          query,
          limit: 24,
          ...(cursor ? { cursor } : {}),
        });
        if (attempt === generation && current(captured)) {
          publish({
            page:
              cursor && snapshot.page
                ? { ...page, items: [...snapshot.page.items, ...page.items] }
                : page,
          });
        }
      } catch (error) {
        if (attempt === generation) {
          publish({ error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (attempt === generation) {
          publish({ loading: false });
        }
      }
    },
    async mutate(kind: "install" | "remove", id: string, version?: string) {
      if (snapshot.mutation) {
        return;
      }
      const captured = capture();
      const attempt = scopeGeneration;
      publish({ mutation: id, error: null, saved: null });
      try {
        if (!current(captured) || !captured.client || !captured.profile) {
          throw new Error("Sign in to install or remove personal themes.");
        }
        await captured.client.request<ThemesMutationResult>(
          kind === "install" ? "themes.install" : "themes.remove",
          { id, ...(version ? { version } : {}) },
        );
        if (attempt === scopeGeneration && current(captured)) {
          refreshInstalled();
          publish({ saved: kind });
        }
      } catch (error) {
        if (attempt === scopeGeneration && current(captured)) {
          publish({ error: error instanceof Error ? error.message : String(error) });
        }
      } finally {
        if (attempt === scopeGeneration) {
          publish({ mutation: null });
        }
      }
    },
    dispose() {
      disposed = true;
      generation++;
      scopeGeneration++;
      unsubscribe();
    },
  };
}
