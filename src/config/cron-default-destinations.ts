// Lists the channels named by configured cron default destinations.
import type { CronConfig } from "./types.cron.js";

/** One explicit channel named by a configured cron default destination. */
export type CronDefaultDestinationChannelRef = {
  /** Config path of the `channel` field, such as `cron.agents.ops.delivery.channel`. */
  path: string;
  channel: string;
  /** True for `cron.failureAlert.channel`, which predates the scoped defaults. */
  globalFailureAlert: boolean;
};

type ChannelRoute = { channel?: string; mode?: string } | undefined;

/**
 * Collects every explicit default channel: `cron.delivery`, `cron.failureAlert`,
 * and the `delivery`/`failureAlert` routes under `cron.agents` and
 * `cron.creators`. `last` and webhook failure routes name no chat channel, and a
 * channel implied by a `to` prefix only resolves for an active plugin, so
 * neither can point at a missing channel.
 */
export function listCronDefaultDestinationChannels(
  cron: Pick<CronConfig, "delivery" | "failureAlert" | "agents" | "creators"> | undefined,
): CronDefaultDestinationChannelRef[] {
  const refs: CronDefaultDestinationChannelRef[] = [];
  const add = (path: string, route: ChannelRoute, globalFailureAlert = false) => {
    const channel = route?.channel?.trim();
    if (channel && channel.toLowerCase() !== "last" && route?.mode !== "webhook") {
      refs.push({ path: `${path}.channel`, channel, globalFailureAlert });
    }
  };
  add("cron.delivery", cron?.delivery);
  add("cron.failureAlert", cron?.failureAlert, true);
  const scoped = { agents: cron?.agents, creators: cron?.creators };
  for (const [scope, entries] of Object.entries(scoped)) {
    for (const [key, entry] of Object.entries(entries ?? {})) {
      add(`cron.${scope}.${key}.delivery`, entry?.delivery);
      add(`cron.${scope}.${key}.failureAlert`, entry?.failureAlert);
    }
  }
  return refs;
}
