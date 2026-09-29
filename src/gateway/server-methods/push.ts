// Push gateway methods send APNs/web-push test notifications and manage web
// push subscriptions/VAPID public-key access for UI clients.
import {
  normalizeOptionalString,
  normalizeStringifiedOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validatePushTestParams,
  validateWebPushSubscribeParams,
  validateWebPushPreferencesGetParams,
  validateWebPushPreferencesSetParams,
  validateWebPushTestParams,
  validateWebPushUnsubscribeParams,
  validateWebPushVapidPublicKeyParams,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  clearApnsRegistrationIfCurrent,
  loadApnsRegistration,
  normalizeApnsEnvironment,
  resolveApnsAuthConfigFromEnv,
  resolveApnsRelayConfigFromEnv,
  sendApnsAlert,
  shouldClearStoredApnsRegistration,
} from "../../infra/push-apns.js";
import {
  WEB_PUSH_USER_PREFERENCES_KEY,
  normalizeWebPushDevicePreferences,
  normalizeWebPushNotificationPreferences,
  resolveEffectiveWebPushPreferences,
} from "../../infra/push-web-preferences.js";
import type {
  WebPushMutationGuard,
  WebPushMutationProfileFacts,
} from "../../infra/push-web-store.records.js";
import {
  WebPushSubscriptionBindingError,
  broadcastWebPush,
  clearBoundWebPushSubscription,
  withBoundWebPushSubscriptionByEndpoint,
  registerWebPushSubscription,
  resolveVapidKeys,
  setWebPushSubscriptionPreferences,
  type BoundWebPushSubscription,
} from "../../infra/push-web.js";
import { getUserPreferences, setUserPreferences } from "../../state/user-preferences.js";
import { resolveUserProfileId } from "../../state/user-profiles.js";
import { authorizeOperatorScopesForMethod } from "../method-scopes.js";
import { isRoleAuthorizedForMethod, parseGatewayRole } from "../role-policy.js";
import { respondUnavailableOnThrow } from "./response.js";
import { readGatewayRequestMutationAuthority } from "./session-mutation-guards.js";
import type { GatewayRequestHandlers, GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type PushRequestOptions = Omit<GatewayRequestHandlerOptions, "context"> & {
  context: Pick<
    GatewayRequestHandlerOptions["context"],
    "getRuntimeConfig" | "getClientConnIds" | "broadcastToConnIds"
  >;
};

function hasValidWebPushQuietHoursTimeZone(preferences: {
  quietHours?: { timeZone: string };
}): boolean {
  const timeZone = preferences.quietHours?.timeZone;
  if (!timeZone) {
    return true;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

function createWebPushRequestGuard(options: PushRequestOptions) {
  const { client, req } = options;
  const authority = readGatewayRequestMutationAuthority(options);
  const method = req.method;
  const deviceId = normalizeOptionalString(client?.connect.device?.id);
  const profileReference = client?.authenticatedUserProfile?.profileId;
  const assertPolicyCurrent = () => {
    const role = parseGatewayRole(client?.connect.role ?? "operator");
    if (
      !role ||
      !isRoleAuthorizedForMethod(role, method) ||
      !authorizeOperatorScopesForMethod(method, client?.connect.scopes ?? []).allowed ||
      normalizeOptionalString(client?.connect.device?.id) !== deviceId
    ) {
      throw new Error("Web Push requester authority changed");
    }
  };
  const assertCurrent = () => {
    authority.assertCurrent();
    assertPolicyCurrent();
    const currentReference = client?.authenticatedUserProfile?.profileId;
    const currentProfileId = currentReference ? resolveUserProfileId(currentReference) : undefined;
    const originalProfileId = profileReference ? resolveUserProfileId(profileReference) : undefined;
    if (
      (currentReference && !currentProfileId) ||
      (profileReference && !originalProfileId) ||
      currentProfileId !== originalProfileId
    ) {
      throw new Error("Web Push requester profile changed");
    }
    return currentProfileId;
  };
  return {
    assertCurrent,
    prepareMutation: (): WebPushMutationGuard => {
      assertCurrent();
      if (authority.family === "native-compatibility") {
        return { family: "native-compatibility", assertCurrent };
      }
      const currentReference = client?.authenticatedUserProfile?.profileId;
      return {
        family: "worker",
        profiles: { original: profileReference ?? null, current: currentReference ?? null },
        assertCurrent: () => {
          authority.assertWorkerCurrent();
          assertPolicyCurrent();
          if (client?.authenticatedUserProfile?.profileId !== currentReference) {
            throw new Error("Web Push requester profile changed");
          }
        },
        assertProfiles: (facts: WebPushMutationProfileFacts) => {
          authority.expectedProfileBinding?.assertMatchesResolvedProfile(
            facts.profileId ?? undefined,
          );
          if (!facts.bindingCurrent) {
            throw new Error("Web Push requester profile changed");
          }
        },
      };
    },
  };
}

type AuthorizedWebPushSubscription = {
  subscription: BoundWebPushSubscription;
  assertCurrent: () => string | undefined;
  prepareMutation: () => WebPushMutationGuard;
};

function withAuthorizedWebPushSubscription<T>(
  endpoint: string,
  options: PushRequestOptions,
  start: (authorized: AuthorizedWebPushSubscription) => T,
) {
  const { client, respond } = options;
  const requester = createWebPushRequestGuard(options);
  const deviceId = normalizeOptionalString(client?.connect.device?.id);
  return withBoundWebPushSubscriptionByEndpoint({ endpoint }, (subscription) => {
    if (!deviceId || !subscription || subscription.deviceId !== deviceId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "subscription is not bound to this device"),
      );
      return undefined;
    }
    const currentProfileId = client?.authenticatedUserProfile?.profileId
      ? resolveUserProfileId(client.authenticatedUserProfile.profileId)
      : undefined;
    const subscriptionProfileId = subscription.userProfileId
      ? resolveUserProfileId(subscription.userProfileId)
      : undefined;
    if (
      (subscription.userProfileId && !subscriptionProfileId) ||
      (client?.authenticatedUserProfile?.profileId && !currentProfileId) ||
      (subscriptionProfileId ?? null) !== (currentProfileId ?? null)
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.FORBIDDEN, "subscription is not bound to this user"),
      );
      return undefined;
    }
    const assertCurrent = () => {
      const profileId = requester.assertCurrent();
      const currentSubscriptionProfileId = subscription.userProfileId
        ? resolveUserProfileId(subscription.userProfileId)
        : undefined;
      if (
        (subscription.userProfileId && !currentSubscriptionProfileId) ||
        currentSubscriptionProfileId !== profileId
      ) {
        throw new Error("Web Push subscription owner changed");
      }
      return profileId;
    };
    assertCurrent();
    return {
      start: () =>
        start({
          subscription,
          assertCurrent,
          prepareMutation: (): WebPushMutationGuard => {
            const guard = requester.prepareMutation();
            return guard.family === "native-compatibility" ? { ...guard, assertCurrent } : guard;
          },
        }),
    };
  });
}

export const pushHandlers = {
  "push.test": async ({ params, respond, context }: PushRequestOptions) => {
    if (!assertValidParams(params, validatePushTestParams, "push.test", respond)) {
      return;
    }

    const nodeId = normalizeStringifiedOptionalString(params.nodeId) ?? "";
    if (!nodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    const title = normalizeOptionalString(params.title) ?? "OpenClaw";
    const body = normalizeOptionalString(params.body) ?? `Push test for node ${nodeId}`;

    await respondUnavailableOnThrow(respond, async () => {
      const registration = await loadApnsRegistration(nodeId);
      if (!registration) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `node ${nodeId} has no APNs registration (connect iOS node first)`,
          ),
        );
        return;
      }

      const overrideEnvironment = normalizeApnsEnvironment(params.environment);
      const result =
        registration.transport === "direct"
          ? await (async () => {
              // Direct registrations require local APNs signing material at
              // send time; relay registrations must not touch those secrets.
              const auth = await resolveApnsAuthConfigFromEnv(process.env);
              if (!auth.ok) {
                respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, auth.error));
                return null;
              }
              return await sendApnsAlert({
                registration: {
                  ...registration,
                  environment: overrideEnvironment ?? registration.environment,
                },
                nodeId,
                title,
                body,
                auth: auth.value,
              });
            })()
          : await (async () => {
              // Relay registrations carry a grant from the node, so the gateway
              // only needs relay config plus the origin bound at registration.
              const relay = resolveApnsRelayConfigFromEnv(
                process.env,
                context.getRuntimeConfig().gateway,
                { registrationRelayOrigin: registration.relayOrigin },
              );
              if (!relay.ok) {
                respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, relay.error));
                return null;
              }
              return await sendApnsAlert({
                registration,
                nodeId,
                title,
                body,
                relayConfig: relay.value,
              });
            })();
      if (!result) {
        return;
      }
      if (
        shouldClearStoredApnsRegistration({
          registration,
          result,
          overrideEnvironment,
        })
      ) {
        // Clear only the exact registration we tested; a reconnect may have
        // written a newer token while the push request was in flight.
        await clearApnsRegistrationIfCurrent({
          nodeId,
          registration,
        });
      }
      respond(true, result, undefined);
    });
  },

  "push.web.vapidPublicKey": async ({ params, respond }: PushRequestOptions) => {
    if (
      !assertValidParams(
        params,
        validateWebPushVapidPublicKeyParams,
        "push.web.vapidPublicKey",
        respond,
      )
    ) {
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const vapid = await resolveVapidKeys();
      respond(true, { vapidPublicKey: vapid.publicKey }, undefined);
    });
  },

  "push.web.subscribe": async (options: PushRequestOptions) => {
    const { params, respond, client, context } = options;
    if (!assertValidParams(params, validateWebPushSubscribeParams, "push.web.subscribe", respond)) {
      return;
    }

    const deviceId = normalizeOptionalString(client?.connect.device?.id);
    if (!deviceId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "paired browser device identity required"),
      );
      return;
    }
    const userProfileId = normalizeOptionalString(client?.authenticatedUserProfile?.profileId);
    if (context.getRuntimeConfig().gateway?.roles && !userProfileId) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "Web Push requires an authenticated user profile when Gateway roles are enabled",
        ),
      );
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      try {
        const requester = createWebPushRequestGuard(options);
        const subscription = await registerWebPushSubscription({
          endpoint: params.endpoint,
          keys: params.keys,
          binding: { deviceId, userProfileId: userProfileId ?? null },
          guard: requester.prepareMutation(),
        });
        respond(true, { subscriptionId: subscription.subscriptionId }, undefined);
      } catch (error) {
        if (!(error instanceof WebPushSubscriptionBindingError)) {
          throw error;
        }
        respond(false, undefined, errorShape(ErrorCodes.FORBIDDEN, error.message));
      }
    });
  },

  "push.web.unsubscribe": async (options: PushRequestOptions) => {
    const { params, respond } = options;
    if (
      !assertValidParams(params, validateWebPushUnsubscribeParams, "push.web.unsubscribe", respond)
    ) {
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      await withAuthorizedWebPushSubscription(params.endpoint, options, (authorized) => {
        const { subscription } = authorized;
        return clearBoundWebPushSubscription({
          endpoint: params.endpoint,
          expectedDeviceId: subscription.deviceId,
          expectedUserProfileId: subscription.userProfileId,
          guard: authorized.prepareMutation(),
        }).then((removed) => {
          if (!removed) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.FORBIDDEN, "subscription binding changed"),
            );
            return;
          }
          respond(true, { removed }, undefined);
        });
      });
    });
  },

  "push.web.preferences.get": async (options: PushRequestOptions) => {
    const { params, respond } = options;
    if (
      !assertValidParams(
        params,
        validateWebPushPreferencesGetParams,
        "push.web.preferences.get",
        respond,
      )
    ) {
      return;
    }
    await withAuthorizedWebPushSubscription(params.endpoint, options, (authorized) => {
      const { subscription } = authorized;
      const currentProfileId = authorized.assertCurrent();
      const storedUser = currentProfileId
        ? getUserPreferences(currentProfileId, [WEB_PUSH_USER_PREFERENCES_KEY])[
            WEB_PUSH_USER_PREFERENCES_KEY
          ]
        : undefined;
      const user = normalizeWebPushNotificationPreferences(storedUser);
      respond(
        true,
        {
          durableIdentity: Boolean(currentProfileId),
          user,
          device: subscription.devicePreferences,
          effective: resolveEffectiveWebPushPreferences({
            user,
            device: subscription.devicePreferences,
          }),
        },
        undefined,
      );
    });
  },

  "push.web.preferences.set": async (options: PushRequestOptions) => {
    const { params, respond, context } = options;
    if (
      !assertValidParams(
        params,
        validateWebPushPreferencesSetParams,
        "push.web.preferences.set",
        respond,
      )
    ) {
      return;
    }
    await withAuthorizedWebPushSubscription(params.endpoint, options, (authorized) => {
      const { subscription } = authorized;
      const currentProfileId = authorized.assertCurrent();
      if (!hasValidWebPushQuietHoursTimeZone(params.preferences)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "invalid notification quiet-hours time zone"),
        );
        return undefined;
      }
      if (params.scope === "user") {
        if (!currentProfileId) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              "user defaults require a durable authenticated profile",
            ),
          );
          return undefined;
        }
        const preferences = normalizeWebPushNotificationPreferences(params.preferences);
        const result = setUserPreferences(currentProfileId, {
          [WEB_PUSH_USER_PREFERENCES_KEY]: preferences,
        });
        if (!result.ok) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "could not save notification preferences"),
          );
          return undefined;
        }
        respond(true, { scope: "user", preferences }, undefined);
        const connIds = context.getClientConnIds?.((connectedClient) => {
          const connectedProfileId = connectedClient.authenticatedUserProfile?.profileId;
          return Boolean(
            connectedProfileId && resolveUserProfileId(connectedProfileId) === currentProfileId,
          );
        });
        if (connIds?.size) {
          context.broadcastToConnIds(
            "users.prefs.changed",
            { profileId: currentProfileId, keys: [WEB_PUSH_USER_PREFERENCES_KEY] },
            connIds,
          );
        }
        return undefined;
      }
      const preferences = normalizeWebPushDevicePreferences(params.preferences);
      return setWebPushSubscriptionPreferences({
        endpoint: params.endpoint,
        preferences,
        expectedDeviceId: subscription.deviceId,
        expectedUserProfileId: subscription.userProfileId,
        guard: authorized.prepareMutation(),
      }).then((updated) => {
        if (!updated) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.FORBIDDEN, "subscription binding changed"),
          );
          return;
        }
        respond(true, { scope: "device", preferences }, undefined);
      });
    });
  },

  "push.web.test": async ({ params, respond }: PushRequestOptions) => {
    if (!assertValidParams(params, validateWebPushTestParams, "push.web.test", respond)) {
      return;
    }

    const title = normalizeOptionalString(params.title) ?? "OpenClaw";
    const body = normalizeOptionalString(params.body) ?? "Web push test notification";

    await respondUnavailableOnThrow(respond, async () => {
      const results = await broadcastWebPush({ title, body });
      if (results.length === 0) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "no web push subscriptions registered"),
        );
        return;
      }
      if (!results.some((result) => result.ok)) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "all web push deliveries failed", {
            details: { results },
          }),
        );
        return;
      }
      respond(true, { results }, undefined);
    });
  },
} satisfies GatewayRequestHandlers;
