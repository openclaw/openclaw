import { theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  addMarketplaceFeedWatch,
  dismissMarketplaceFeedUpdate,
  listMarketplaceFeedUpdates,
  listMarketplaceFeedWatches,
  markMarketplaceFeedUpdateRead,
  removeMarketplaceFeedWatch,
  setMarketplaceFeedWatchMuted,
  type MarketplaceFeedWatch,
} from "../plugins/official-external-plugin-catalog-watch-store.js";
import { defaultRuntime } from "../runtime.js";

export type MarketplaceWatchAddOptions = {
  feedProfile?: string;
  feedUrl?: string;
  json?: boolean;
  offline?: boolean;
};

export type MarketplaceWatchTargetOptions = {
  feedId?: string;
  json?: boolean;
};

export type MarketplaceWatchListOptions = {
  json?: boolean;
};

export type MarketplaceUpdateListOptions = {
  all?: boolean;
  json?: boolean;
  limit?: number;
  unread?: boolean;
};

function fail(message: string): never {
  defaultRuntime.error(message);
  defaultRuntime.exit(1);
  throw new Error(message);
}

function selectWatch(itemId: string, feedId?: string): MarketplaceFeedWatch {
  const matches = listMarketplaceFeedWatches().filter(
    (watch) =>
      watch.itemKind === "plugin" &&
      watch.itemId === itemId &&
      (feedId === undefined || watch.feedId === feedId),
  );
  if (matches.length === 0) {
    return fail(`No marketplace watch found for plugin ${itemId}.`);
  }
  if (matches.length > 1) {
    return fail(`Plugin ${itemId} is watched in multiple feeds; pass --feed-id.`);
  }
  return matches[0]!;
}

export async function runMarketplaceWatchAddCommand(
  itemId: string,
  opts: MarketplaceWatchAddOptions,
): Promise<void> {
  const catalog = await import("../plugins/official-external-plugin-catalog.js");
  const config = getRuntimeConfig();
  const result = await catalog.loadConfiguredHostedOfficialExternalPluginCatalogEntries(config, {
    ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
    ...(opts.feedUrl ? { feedUrl: opts.feedUrl } : {}),
    ...(opts.offline ? { offline: true } : {}),
  });
  if (result.source === "bundled-fallback") {
    return fail("Marketplace watches require an accepted signed feed snapshot.");
  }
  if (result.trust?.mode !== "signed") {
    return fail("Marketplace watches require an accepted signed feed snapshot.");
  }
  const entry = result.entries.find(
    (candidate) => catalog.resolveOfficialExternalPluginId(candidate) === itemId,
  );
  if (!entry) {
    return fail(`Plugin ${itemId} was not found in feed ${result.feed.id}.`);
  }
  const added = addMarketplaceFeedWatch({
    feedId: result.feed.id,
    ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
    feedUrl: result.metadata.url,
    itemKind: "plugin",
    itemId,
    sequence: result.feed.sequence,
    baselineEntry: entry,
  });
  if (opts.json) {
    defaultRuntime.writeJson(added);
    return;
  }
  const action = added.created ? theme.success("Watching") : theme.muted("Already watching");
  defaultRuntime.log(`${action} ${theme.command(itemId)} in ${result.feed.id}.`);
}

export function runMarketplaceWatchRemoveCommand(
  itemId: string,
  opts: MarketplaceWatchTargetOptions,
): void {
  const watch = selectWatch(itemId, opts.feedId);
  const removed = removeMarketplaceFeedWatch({
    feedId: watch.feedId,
    itemKind: watch.itemKind,
    itemId: watch.itemId,
  });
  if (opts.json) {
    defaultRuntime.writeJson({ removed, watch });
    return;
  }
  defaultRuntime.log(`${theme.success("Stopped watching")} ${theme.command(itemId)}.`);
}

export function runMarketplaceWatchListCommand(opts: MarketplaceWatchListOptions): void {
  const watches = listMarketplaceFeedWatches();
  if (opts.json) {
    defaultRuntime.writeJson({ watches, count: watches.length });
    return;
  }
  if (watches.length === 0) {
    defaultRuntime.log(theme.muted("No marketplace item watches."));
    return;
  }
  defaultRuntime.log(
    watches
      .map((watch) => {
        const muted = watch.muted ? theme.muted(" muted") : "";
        return `${theme.command(watch.itemId)} ${theme.muted(watch.feedId)}${muted}`;
      })
      .join("\n"),
  );
}

export function runMarketplaceWatchMuteCommand(
  itemId: string,
  muted: boolean,
  opts: MarketplaceWatchTargetOptions,
): void {
  const watch = selectWatch(itemId, opts.feedId);
  const changed = setMarketplaceFeedWatchMuted({
    feedId: watch.feedId,
    itemKind: watch.itemKind,
    itemId: watch.itemId,
    muted,
  });
  if (opts.json) {
    defaultRuntime.writeJson({ changed, muted, watch });
    return;
  }
  defaultRuntime.log(
    `${theme.success(muted ? "Muted" : "Unmuted")} ${theme.command(itemId)} updates.`,
  );
}

export function runMarketplaceUpdateListCommand(opts: MarketplaceUpdateListOptions): void {
  const updates = listMarketplaceFeedUpdates({
    ...(opts.all ? { includeDismissed: true } : {}),
    ...(opts.limit ? { limit: opts.limit } : {}),
    ...(opts.unread ? { unreadOnly: true } : {}),
  });
  if (opts.json) {
    defaultRuntime.writeJson({ updates, count: updates.length });
    return;
  }
  if (updates.length === 0) {
    defaultRuntime.log(theme.muted("No marketplace feed updates."));
    return;
  }
  defaultRuntime.log(
    updates
      .map((update) => {
        const unread = update.readAt ? "" : "* ";
        const version = update.itemVersion ? ` ${theme.muted(update.itemVersion)}` : "";
        return `${unread}${theme.command(update.eventId)} ${update.reason} ${update.itemId}${version}`;
      })
      .join("\n"),
  );
}

export function runMarketplaceUpdateReadCommand(eventId: string, json?: boolean): void {
  const changed = markMarketplaceFeedUpdateRead(eventId);
  if (!changed) {
    return fail(`Marketplace feed update ${eventId} was not found.`);
  }
  if (json) {
    defaultRuntime.writeJson({ eventId, read: true });
    return;
  }
  defaultRuntime.log(`${theme.success("Read")} ${theme.command(eventId)}.`);
}

export function runMarketplaceUpdateDismissCommand(eventId: string, json?: boolean): void {
  const changed = dismissMarketplaceFeedUpdate(eventId);
  if (!changed) {
    return fail(`Marketplace feed update ${eventId} was not found.`);
  }
  if (json) {
    defaultRuntime.writeJson({ eventId, dismissed: true });
    return;
  }
  defaultRuntime.log(`${theme.success("Dismissed")} ${theme.command(eventId)}.`);
}
