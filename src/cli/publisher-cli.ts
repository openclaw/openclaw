import type { Command } from "commander";
import { theme } from "../../packages/terminal-core/src/theme.js";
import { getRuntimeConfig } from "../config/config.js";
import {
  followPublisherFeedByHandle,
  listFollowedPublisherFeeds,
  refreshFollowedPublisherFeeds,
  searchPublisherFeed,
  unfollowPublisherFeed,
} from "../plugins/publisher-feed-follow-service.js";
import { createSqlitePublisherFeedFollowStore } from "../plugins/publisher-feed-follow-store.js";
import { createSqlitePublisherFeedStateStore } from "../plugins/publisher-feed-state-store.js";
import { defaultRuntime } from "../runtime.js";
import { applyParentDefaultHelpAction } from "./program/parent-default-help.js";

type PublisherCommandOptions = {
  feedProfile?: string;
  json?: boolean;
  kind?: string[];
  limit?: string;
};

function createDependencies() {
  const config = getRuntimeConfig();
  return {
    follows: createSqlitePublisherFeedFollowStore(),
    states: createSqlitePublisherFeedStateStore(),
    marketplaces: config.marketplaces,
  };
}

function feedProfile(opts: PublisherCommandOptions): string {
  const profile = opts.feedProfile?.trim();
  if (!profile) {
    throw new Error("--feed-profile is required");
  }
  return profile;
}

function emit(value: unknown, opts: PublisherCommandOptions, line: string): void {
  if (opts.json) {
    defaultRuntime.writeJson(value);
    return;
  }
  defaultRuntime.log(line);
}

export function registerPublisherCli(program: Command): void {
  const publisher = program
    .command("publisher")
    .description("Follow and refresh signed publisher feeds");

  publisher
    .command("search")
    .description("Search a signed publisher feed")
    .argument("<publisher-id>", "Stable publisher id")
    .argument("[query]", "Search text")
    .requiredOption("--feed-profile <name>", "Configured signed marketplace feed profile")
    .option("--kind <kind...>", "Limit results to skill or plugin")
    .option("--limit <count>", "Maximum result count")
    .option("--json", "Print JSON")
    .action(
      async (publisherId: string, query: string | undefined, opts: PublisherCommandOptions) => {
        const kinds = opts.kind?.map((kind) => {
          if (kind !== "skill" && kind !== "plugin") {
            throw new Error("--kind must be skill or plugin");
          }
          return kind;
        });
        if (!query?.trim() && (!kinds || kinds.length === 0)) {
          throw new Error("publisher search requires query text or --kind");
        }
        const limit = opts.limit === undefined ? undefined : Number(opts.limit);
        const result = await searchPublisherFeed({
          publisherId,
          feedProfile: feedProfile(opts),
          query: {
            ...(query ? { text: query } : {}),
            ...(kinds && kinds.length > 0 ? { kinds } : {}),
          },
          ...(limit === undefined ? {} : { limit }),
          deps: createDependencies(),
        });
        if (opts.json) {
          defaultRuntime.writeJson(result);
          return;
        }
        defaultRuntime.log(
          result.entries
            .map((entry) => `${theme.command(entry.name)} ${theme.muted(entry.url)}`)
            .join("\n"),
        );
      },
    );

  publisher
    .command("list")
    .description("List followed publisher feeds")
    .option("--json", "Print JSON")
    .action(async (opts: PublisherCommandOptions) => {
      const follows = await listFollowedPublisherFeeds(createDependencies());
      if (opts.json) {
        defaultRuntime.writeJson({ follows });
        return;
      }
      if (follows.length === 0) {
        defaultRuntime.log(theme.muted("No publisher feeds followed."));
        return;
      }
      defaultRuntime.log(
        follows
          .map((follow) => {
            const sequence =
              follow.acceptedSequence === null
                ? "not refreshed"
                : `sequence ${follow.acceptedSequence}`;
            return `${theme.command(follow.publisherId)} ${theme.muted(`${follow.feedProfile} ${sequence}`)}`;
          })
          .join("\n"),
      );
    });

  publisher
    .command("follow")
    .description("Follow a signed publisher feed")
    .argument("<handle>", "Publisher handle")
    .requiredOption("--feed-profile <name>", "Configured signed marketplace feed profile")
    .option("--json", "Print JSON")
    .action(async (publisherHandle: string, opts: PublisherCommandOptions) => {
      const result = await followPublisherFeedByHandle({
        publisherHandle,
        feedProfile: feedProfile(opts),
        deps: createDependencies(),
      });
      emit(
        result,
        opts,
        `${theme.success("Followed")} ${result.follow.publisherId} at sequence ${result.refresh.record.state.sequence}.`,
      );
    });

  publisher
    .command("unfollow")
    .description("Stop following a publisher feed")
    .argument("<publisher-id>", "Stable publisher id")
    .requiredOption("--feed-profile <name>", "Configured signed marketplace feed profile")
    .option("--json", "Print JSON")
    .action(async (publisherId: string, opts: PublisherCommandOptions) => {
      const removed = await unfollowPublisherFeed({
        publisherId,
        feedProfile: feedProfile(opts),
        deps: createDependencies(),
      });
      emit(
        { publisherId: publisherId.trim(), removed },
        opts,
        removed
          ? `${theme.success("Unfollowed")} ${publisherId.trim()}.`
          : `${theme.muted("Not followed:")} ${publisherId.trim()}.`,
      );
    });

  publisher
    .command("refresh")
    .description("Refresh followed publisher feeds")
    .argument("[publisher-id]", "Refresh only this stable publisher id")
    .option("--feed-profile <name>", "Limit refresh to one configured feed profile")
    .option("--json", "Print JSON")
    .action(async (publisherId: string | undefined, opts: PublisherCommandOptions) => {
      const results = await refreshFollowedPublisherFeeds({
        deps: createDependencies(),
        ...(publisherId ? { publisherId } : {}),
        ...(opts.feedProfile ? { feedProfile: opts.feedProfile } : {}),
      });
      if (opts.json) {
        defaultRuntime.writeJson({ results });
      } else if (results.length === 0) {
        defaultRuntime.log(theme.muted("No matching publisher feeds followed."));
      } else {
        defaultRuntime.log(
          results
            .map((entry) =>
              entry.ok
                ? `${theme.success(entry.result.status)} ${entry.follow.publisherId} sequence ${entry.result.record.state.sequence}`
                : `${theme.error("failed")} ${entry.follow.publisherId}: ${entry.error}`,
            )
            .join("\n"),
        );
      }
      if (results.some((entry) => !entry.ok)) {
        defaultRuntime.exit(1);
      }
    });

  applyParentDefaultHelpAction(publisher);
}
