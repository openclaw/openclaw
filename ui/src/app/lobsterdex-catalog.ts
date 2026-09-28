import type { LobsterCatalogEntry } from "../../../packages/gateway-protocol/src/lobsterdex.ts";
import type { ControlUiClawmoji } from "../../../src/plugin-sdk/control-ui-lobsterdex.ts";
import { lobsterPaletteName, LOBSTER_PALETTE_LORE } from "../components/lobster-pet-lore.ts";
import { LOBSTER_PET_PALETTES } from "../components/lobster-pet-palettes.ts";
import type { ApplicationGateway } from "./gateway.ts";

export const BUILTIN_CLAWMOJIS: readonly ControlUiClawmoji[] = LOBSTER_PET_PALETTES.map(
  (palette) => ({
    id: palette.id,
    name: lobsterPaletteName(palette.id),
    description: LOBSTER_PALETTE_LORE[palette.id].flavor,
    source: "builtin",
    appearance: { kind: "builtin", paletteId: palette.id },
  }),
);

type CatalogSnapshot = {
  entries: readonly ControlUiClawmoji[];
  loading: boolean;
  error: string | null;
};

function createCatalog(gateway: ApplicationGateway) {
  let snapshot: CatalogSnapshot = { entries: BUILTIN_CLAWMOJIS, loading: false, error: null };
  const listeners = new Set<() => void>();
  let disposed = false;
  let generation = 0;
  let client = gateway.snapshot.client;
  let url = gateway.connection.gatewayUrl;
  let profile = gateway.snapshot.selfUser?.id;
  let connected = gateway.snapshot.phase === "connected";
  const publish = (next: CatalogSnapshot) => {
    snapshot = next;
    for (const listener of listeners) {
      listener();
    }
  };
  const refresh = async () => {
    const owner = gateway.snapshot.client;
    if (disposed || gateway.snapshot.phase !== "connected" || !owner) {
      throw new Error("Connect to the Gateway to load Lobster Packs.");
    }
    const request = ++generation;
    const ownerProfile = gateway.snapshot.selfUser?.id;
    const ownerUrl = gateway.connection.gatewayUrl;
    const current = () =>
      !disposed &&
      request === generation &&
      gateway.snapshot.phase === "connected" &&
      gateway.snapshot.client === owner &&
      gateway.snapshot.selfUser?.id === ownerProfile &&
      gateway.connection.gatewayUrl === ownerUrl;
    publish({ ...snapshot, loading: true, error: null });
    try {
      const result = await owner.request<{ entries: LobsterCatalogEntry[] }>(
        "lobsterdex.catalog",
        {},
      );
      if (!current()) {
        return;
      }
      publish({ entries: [...BUILTIN_CLAWMOJIS, ...result.entries], loading: false, error: null });
    } catch (error) {
      if (!current()) {
        return;
      }
      // A failed authoritative refresh must not retain revoked plugin artwork.
      publish({
        entries: BUILTIN_CLAWMOJIS,
        loading: false,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  const automaticRefresh = () => {
    void refresh().catch(() => {
      /* Error is visible in snapshot. */
    });
  };
  const stopGateway = gateway.subscribe(() => {
    const nextConnected = gateway.snapshot.phase === "connected";
    if (
      client === gateway.snapshot.client &&
      url === gateway.connection.gatewayUrl &&
      profile === gateway.snapshot.selfUser?.id &&
      connected === nextConnected
    ) {
      return;
    }
    generation++;
    client = gateway.snapshot.client;
    url = gateway.connection.gatewayUrl;
    profile = gateway.snapshot.selfUser?.id;
    connected = nextConnected;
    publish({ entries: BUILTIN_CLAWMOJIS, loading: false, error: null });
    if (connected) {
      automaticRefresh();
    }
  });
  const stopEvents = gateway.subscribeEvents((event) => {
    if (event.event === "plugins.changed" && gateway.snapshot.phase === "connected") {
      automaticRefresh();
    }
  });
  if (connected) {
    queueMicrotask(() => {
      if (!disposed) {
        automaticRefresh();
      }
    });
  }
  return {
    get snapshot() {
      return snapshot;
    },
    refresh,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispose() {
      disposed = true;
      generation++;
      stopGateway();
      stopEvents();
      listeners.clear();
    },
  };
}

const catalogs = new WeakMap<
  ApplicationGateway,
  { refs: number; catalog: ReturnType<typeof createCatalog> }
>();

/** One connection-scoped projection shared by the Dex and plugin components. */
export function acquireLobsterdexCatalog(gateway: ApplicationGateway) {
  let retained = catalogs.get(gateway);
  if (!retained) {
    retained = { refs: 0, catalog: createCatalog(gateway) };
    catalogs.set(gateway, retained);
  }
  retained.refs++;
  const owner = retained;
  let released = false;
  return {
    get snapshot() {
      return owner.catalog.snapshot;
    },
    refresh: owner.catalog.refresh,
    subscribe: (listener: () => void) => owner.catalog.subscribe(listener),
    release() {
      if (released) {
        return;
      }
      released = true;
      if (--owner.refs === 0) {
        owner.catalog.dispose();
        catalogs.delete(gateway);
      }
    },
  };
}
