import type {
  PluginCatalogItem,
  PluginDiscoveryEntry,
  PluginDiscoveryResult,
} from "../../lib/plugins/index.ts";

export const PLUGIN_PREVIEW_SIZE = 8;

export function indexInstalledCatalog(inventory: readonly PluginCatalogItem[] | undefined) {
  const entries = new Map<string, PluginCatalogItem>();
  // Inventory order decides which installed copy supplies a catalog entry's state.
  for (const plugin of inventory ?? []) {
    if (plugin.installed && plugin.catalogId !== undefined && !entries.has(plugin.catalogId)) {
      entries.set(plugin.catalogId, plugin);
    }
  }
  return entries;
}

export function installedState(
  plugin: PluginDiscoveryEntry,
  installedByCatalogId: ReadonlyMap<string, PluginCatalogItem>,
) {
  // Inventory can publish newer local state before catalog pages are read again.
  const entry = installedByCatalogId.get(plugin.id);
  const state = entry?.state ?? plugin.local.state;
  return (entry !== undefined || plugin.local.installed) && state !== "not-installed"
    ? state
    : null;
}

/** Best-effort continuations belong to one cached overview, never to View all or Search. */
export function createOverviewPreviews(options: {
  overview: PluginDiscoveryResult;
  inventory: () => readonly PluginCatalogItem[] | undefined;
  presented: () => boolean;
  load: (category: string, cursor: string, signal: AbortSignal) => Promise<PluginDiscoveryResult>;
  publish: (items: PluginDiscoveryEntry[]) => void;
}) {
  const controller = new AbortController();
  const shelves = (options.overview.categories ?? [])
    .filter((category) => category.previewCursor && category.slug !== "other")
    .map(({ slug, previewCursor }) => ({
      slug,
      cursor: previewCursor,
      requested: new Set<string>(),
    }));
  let items = options.overview.items;
  const ids = new Set(items.map((item) => item.id));
  type Shelf = (typeof shelves)[number];
  const pending = new Set<Shelf>();
  let budget = 32;

  function nextCursor(shelf: Shelf) {
    const cursor = shelf.cursor;
    return budget > 0 && cursor && !shelf.requested.has(cursor) && shelf.requested.size < 3
      ? cursor
      : undefined;
  }

  async function continueShelf(shelf: Shelf, cursor: string) {
    try {
      const page = await options.load(shelf.slug, cursor, controller.signal);
      if (controller.signal.aborted || page.remoteError) {
        return;
      }
      shelf.cursor = page.nextCursor;
      // Keep this bounded page: newer inventory can hide today's first eight. The original
      // overview retains its promoted ranks when an entry appears on more than one shelf.
      const additions = page.items.filter((item) => !ids.has(item.id));
      if (additions.length) {
        for (const item of additions) {
          ids.add(item.id);
        }
        items = [...items, ...additions];
      }
    } catch {
      // Keep the usable preview; explicit refresh starts with a fresh snapshot and budget.
    } finally {
      pending.delete(shelf);
      if (!controller.signal.aborted && options.presented()) {
        fill();
        // Publish the rows and their remaining reservations together, even on an empty/error page.
        options.publish(items);
      }
    }
  }

  function fill() {
    if (controller.signal.aborted || !options.presented() || budget === 0 || !shelves.length) {
      return;
    }
    const installed = indexInstalledCatalog(options.inventory());
    for (const shelf of shelves) {
      // Bound concurrency, total work, and depth even for repeated or empty registry pages.
      if (pending.size >= 2 || budget === 0) {
        break;
      }
      const cursor = nextCursor(shelf);
      if (!cursor) {
        continue;
      }
      const available = items.filter(
        (item) => item.catalog.categories.includes(shelf.slug) && !installedState(item, installed),
      );
      if (available.length >= PLUGIN_PREVIEW_SIZE) {
        continue;
      }
      shelf.requested.add(cursor);
      shelf.cursor = undefined;
      budget--;
      pending.add(shelf);
      void continueShelf(shelf, cursor);
    }
  }
  return {
    get items() {
      return items;
    },
    get continuableCategories() {
      // Queued shelves reserve geometry too; two concurrent requests need not finish together.
      return shelves
        .filter((shelf) => pending.has(shelf) || nextCursor(shelf))
        .map((shelf) => shelf.slug);
    },
    fill,
    cancel: () => controller.abort(),
  };
}
