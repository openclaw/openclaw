import { randomUUID } from "node:crypto";
import {
  ErrorCodes,
  errorShape,
  validateUsersChannelIdentityParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_OWNER_PROFILE_ID,
  type UsersChannelIdentityResult,
} from "../../../packages/gateway-protocol/src/schema/users.js";
import { resolveChannelPluginRegistration } from "../../channels/plugins/registry.js";
import { resolveChannelConfigRecord } from "../../config/channel-config-activation.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { UserChannelIdentityConflictError } from "../../state/user-channel-identities.js";
import {
  changeCanonicalUserChannelIdentity,
  listCanonicalUserChannelIdentities,
} from "../../state/user-channel-identity-operations.js";
import { createProviderBrowserAuthSession } from "../provider-browser-auth.js";
import { preparePersonalProfileAction } from "./personal-profile-authorization.js";
import type { GatewayRequestHandlers } from "./types.js";
import { defineValidatedGatewayMethod } from "./validation.js";

type Pending = {
  requestId: string;
  result: UsersChannelIdentityResult;
  close: () => void;
};
// One pending proof per own profile/channel/account, including across browser tabs.
// Proofs are intentionally ephemeral; restart or lost initiating access requires a new sign-in.
const pending = new Map<string, Pending>();
const TIMEOUT_MS = 5 * 60_000;
function cancel(key: string) {
  const flow = pending.get(key);
  pending.delete(key);
  flow?.close();
}

export const usersChannelIdentityHandlers: GatewayRequestHandlers = {
  "users.channelIdentity": defineValidatedGatewayMethod(
    "users.channelIdentity",
    validateUsersChannelIdentityParams,
    async (options) => {
      try {
        const action = await preparePersonalProfileAction(options, "operator.sessions.read");
        if (action.owner === GATEWAY_OWNER_PROFILE_ID) {
          throw new Error("Sign in with your own profile to link a channel account.");
        }
        const { params, context, client } = options;
        // An unconfigured channel must not load its bundled runtime just to report status.
        const resolvePlugin = () =>
          resolveChannelPluginRegistration(params.channelId, {
            loadedOnly:
              resolveChannelConfigRecord(context.getRuntimeConfig(), params.channelId) === null,
          })?.plugin;
        const plugin = resolvePlugin();
        const links = await listCanonicalUserChannelIdentities(action.owner);
        action.assertCurrent();
        if (params.action === "status") {
          const ids = new Set([
            ...(plugin?.config.listAccountIds(context.getRuntimeConfig()) ?? []),
            ...links
              .filter((link) => link.identity.channelId === params.channelId)
              .map((link) => link.identity.accountId),
          ]);
          const accounts = await Promise.all(
            [...ids].map(async (accountId) => ({
              accountId,
              available: Boolean(
                await plugin?.identityLink?.prepare(context.getRuntimeConfig(), accountId),
              ),
              senderIds: links
                .filter(
                  (link) =>
                    link.identity.channelId === params.channelId &&
                    link.identity.accountId === accountId,
                )
                .map((link) => link.identity.senderId),
            })),
          );
          action.assertCurrent();
          options.respond(true, { status: "ready", accounts } satisfies UsersChannelIdentityResult);
          return;
        }
        const { channelId, accountId } = params;
        const key = JSON.stringify([action.owner, channelId, accountId]);
        if (params.action === "poll" || params.action === "cancel") {
          const flow = pending.get(key);
          if (!flow || flow.requestId !== params.requestId) {
            throw new Error("Account linking expired. Connect again from your profile.");
          }
          if (params.action === "cancel") {
            cancel(key);
            options.respond(true, { status: "cancelled" } satisfies UsersChannelIdentityResult);
          } else {
            options.respond(true, flow.result);
          }
          return;
        }
        const linked = links.filter(
          (link) => link.identity.channelId === channelId && link.identity.accountId === accountId,
        );
        if (params.action === "disconnect") {
          cancel(key);
          for (const link of linked) {
            await changeCanonicalUserChannelIdentity("unlink", action.owner, link.identity, {
              assertCurrent: action.assertCurrent,
            });
          }
          options.respond(true, { status: "ready" } satisfies UsersChannelIdentityResult);
          return;
        }
        if (linked.length) {
          throw new Error("Disconnect your linked account before connecting another one.");
        }
        const adapter = await plugin?.identityLink?.prepare(context.getRuntimeConfig(), accountId);
        action.assertCurrent();
        if (!adapter) {
          throw new Error(
            "Account linking is not configured for this channel account. Ask your Gateway administrator.",
          );
        }
        const ready = createDeferredCore<string>();
        const session = createProviderBrowserAuthSession({
          signal: action.signal,
          browserOrigin: client?.browserOrigin,
          browserBinding: {
            cookieName: "openclaw-channel-link-" + params.browserNonce,
            cookieValue: params.browserNonce,
          },
          openUrl: async (url) => {
            ready.resolve(url);
          },
        });
        cancel(key);
        const requestId = randomUUID();
        const cleanup = setTimeout(() => {
          if (pending.get(key) === flow) {
            cancel(key);
          }
        }, TIMEOUT_MS + 60_000);
        cleanup.unref();
        const flow: Pending = {
          requestId,
          result: { status: "pending", requestId },
          close: () => {
            clearTimeout(cleanup);
            session.close();
          },
        };
        pending.set(key, flow);
        const assertCurrent = () => {
          action.assertCurrent();
          session.assertCurrent();
          if (
            pending.get(key) !== flow ||
            !adapter.isCurrent(context.getRuntimeConfig()) ||
            resolvePlugin() !== plugin
          ) {
            throw new Error("Account linking changed. Connect again from your profile.");
          }
        };
        let redirectUri = "";
        void session
          .authorizePrepared({
            timeoutMs: TIMEOUT_MS,
            prepare: (redirectUrl) => {
              assertCurrent();
              redirectUri = redirectUrl;
              const state = randomUUID();
              return { state, authorizationUrl: adapter.authorizationUrl({ state, redirectUri }) };
            },
          })
          .then(async ({ code }) => {
            assertCurrent();
            const identity = await adapter.exchange({
              code,
              redirectUri,
              signal: session.signal,
              assertCurrent,
            });
            assertCurrent();
            await changeCanonicalUserChannelIdentity(
              "link",
              action.owner,
              { channelId, accountId, senderId: identity.senderId },
              { assertCurrent },
            );
            flow.result = { status: "linked", requestId };
          })
          .catch((error: unknown) => {
            const message =
              error instanceof UserChannelIdentityConflictError
                ? "This channel account is already linked to another profile. Disconnect it there first or contact your administrator."
                : "Account linking was not completed. Check your sign-in and try connecting again.";
            flow.result = { status: "failed", requestId, message };
            ready.reject(new Error(message));
          })
          .finally(() => {
            session.close();
          });
        const authorizationUrl = await ready.promise;
        action.assertCurrent();
        options.respond(true, {
          status: "pending",
          requestId,
          authorizationUrl,
        } satisfies UsersChannelIdentityResult);
      } catch (error) {
        options.respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            error instanceof Error ? error.message : "Account linking is unavailable. Try again.",
          ),
        );
      }
    },
  ),
};
