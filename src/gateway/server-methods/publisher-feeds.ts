import {
  ErrorCodes,
  errorShape,
  validatePublisherFeedsFollowParams,
  validatePublisherFeedsListParams,
  validatePublisherFeedsRefreshParams,
  validatePublisherFeedsStatusParams,
  validatePublisherFeedsUnfollowParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  followPublisherFeed,
  listFollowedPublisherFeeds,
  PublisherFeedFollowInputError,
  unfollowPublisherFeed,
  type PublisherFeedFollowServiceDependencies,
} from "../../plugins/publisher-feed-follow-service.js";
import { createSqlitePublisherFeedFollowStore } from "../../plugins/publisher-feed-follow-store.js";
import { createSqlitePublisherFeedStateStore } from "../../plugins/publisher-feed-state-store.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

type PublisherFeedHandlerDependencies = {
  createServiceDependencies: (
    context: GatewayRequestContext,
  ) => PublisherFeedFollowServiceDependencies;
  follow: typeof followPublisherFeed;
  list: typeof listFollowedPublisherFeeds;
  unfollow: typeof unfollowPublisherFeed;
};

const defaultDependencies: PublisherFeedHandlerDependencies = {
  createServiceDependencies: (context) => ({
    follows: createSqlitePublisherFeedFollowStore(),
    states: createSqlitePublisherFeedStateStore(),
    marketplaces: context.getRuntimeConfig().marketplaces,
  }),
  follow: followPublisherFeed,
  list: listFollowedPublisherFeeds,
  unfollow: unfollowPublisherFeed,
};

function requirePublisherFeedRefresh(context: GatewayRequestContext) {
  const refresh = context.getPublisherFeedRefresh?.();
  if (!refresh) {
    throw new Error("publisher feed refresh is unavailable in this gateway context");
  }
  return refresh;
}

function respondError(
  respond: Parameters<GatewayRequestHandlers[string]>[0]["respond"],
  error: unknown,
  code: Parameters<typeof errorShape>[0] = ErrorCodes.UNAVAILABLE,
) {
  respond(false, undefined, errorShape(code, formatErrorMessage(error)));
}

export function createPublisherFeedsHandlers(
  dependencies: PublisherFeedHandlerDependencies = defaultDependencies,
): GatewayRequestHandlers {
  return {
    "publisherFeeds.list": async ({ params, respond, context }) => {
      if (
        !assertValidParams(params, validatePublisherFeedsListParams, "publisherFeeds.list", respond)
      ) {
        return;
      }
      try {
        const refresh = requirePublisherFeedRefresh(context);
        respond(
          true,
          {
            follows: await dependencies.list(dependencies.createServiceDependencies(context)),
            refresh: refresh.status(),
          },
          undefined,
        );
      } catch (error) {
        respondError(respond, error);
      }
    },
    "publisherFeeds.follow": async ({ params, respond, context }) => {
      if (
        !assertValidParams(
          params,
          validatePublisherFeedsFollowParams,
          "publisherFeeds.follow",
          respond,
        )
      ) {
        return;
      }
      try {
        const deps = dependencies.createServiceDependencies(context);
        const { follow } = await dependencies.follow({
          publisherId: params.publisherId,
          feedProfile: params.feedProfile,
          deps,
        });
        const status = (await dependencies.list(deps)).find(
          (candidate) =>
            candidate.sourceOrigin === follow.sourceOrigin &&
            candidate.publisherId === follow.publisherId,
        );
        if (!status) {
          throw new Error("followed publisher feed was not readable after persistence");
        }
        respond(true, { follow: status }, undefined);
      } catch (error) {
        respondError(
          respond,
          error,
          error instanceof PublisherFeedFollowInputError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
        );
      }
    },
    "publisherFeeds.unfollow": async ({ params, respond, context }) => {
      if (
        !assertValidParams(
          params,
          validatePublisherFeedsUnfollowParams,
          "publisherFeeds.unfollow",
          respond,
        )
      ) {
        return;
      }
      try {
        const removed = await dependencies.unfollow({
          publisherId: params.publisherId,
          feedProfile: params.feedProfile,
          deps: dependencies.createServiceDependencies(context),
        });
        respond(true, { removed }, undefined);
      } catch (error) {
        respondError(
          respond,
          error,
          error instanceof PublisherFeedFollowInputError
            ? ErrorCodes.INVALID_REQUEST
            : ErrorCodes.UNAVAILABLE,
        );
      }
    },
    "publisherFeeds.refresh": async ({ params, respond, context }) => {
      if (
        !assertValidParams(
          params,
          validatePublisherFeedsRefreshParams,
          "publisherFeeds.refresh",
          respond,
        )
      ) {
        return;
      }
      try {
        respond(true, { status: await requirePublisherFeedRefresh(context).runNow() }, undefined);
      } catch (error) {
        respondError(respond, error);
      }
    },
    "publisherFeeds.status": ({ params, respond, context }) => {
      if (
        !assertValidParams(
          params,
          validatePublisherFeedsStatusParams,
          "publisherFeeds.status",
          respond,
        )
      ) {
        return;
      }
      try {
        respond(true, { status: requirePublisherFeedRefresh(context).status() }, undefined);
      } catch (error) {
        respondError(respond, error);
      }
    },
  };
}

export const publisherFeedsHandlers = createPublisherFeedsHandlers();
