import { safeParseJson } from "@openclaw/normalization-core/json-coercion";
import type { Insertable, Selectable } from "kysely";
import type { WebPushDevicePreferences } from "../../packages/gateway-protocol/src/schema/push.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import { normalizeWebPushDevicePreferences } from "./push-web-preferences.js";

export const WEB_PUSH_VAPID_STATE_KEY = "webPush.vapidKeys";
export const DEFAULT_WEB_PUSH_VAPID_SUBJECT = "https://openclaw.ai";
const WEB_PUSH_MAX_ENDPOINT_LENGTH = 2048;
const WEB_PUSH_MAX_KEY_LENGTH = 512;

export type WebPushSubscription = {
  subscriptionId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAtMs: number;
  updatedAtMs: number;
};

export type BoundWebPushSubscription = WebPushSubscription & {
  deviceId: string;
  userProfileId: string | null;
  devicePreferences: WebPushDevicePreferences;
};

export type WebPushMutationProfiles = {
  original: string | null;
  current: string | null;
};

export type WebPushMutationProfileFacts = {
  profileId: string | null;
  bindingCurrent: boolean;
};

export type WebPushMutationGuard =
  | {
      family: "worker";
      profiles: WebPushMutationProfiles;
      assertCurrent: () => void;
      assertProfiles: (facts: WebPushMutationProfileFacts) => void;
    }
  | { family: "native-compatibility"; assertCurrent: () => void };

export type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export function createWebPushVapidKeyPair(
  publicKey: string,
  privateKey: string,
  subject: string,
): VapidKeyPair {
  return { publicKey, privateKey, subject };
}

export type WebPushDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "config_machine_state"
  | "operator_approvals"
  | "web_push_approval_deliveries"
  | "web_push_subscriptions"
>;
type WebPushSubscriptionRow = Selectable<WebPushDatabase["web_push_subscriptions"]>;
type WebPushSubscriptionInsert = Insertable<WebPushDatabase["web_push_subscriptions"]>;

export function hashWebPushEndpoint(endpoint: string): string {
  return sha256HexPrefixCore(endpoint, 32);
}

export function isValidWebPushEndpoint(endpoint: string): boolean {
  if (!endpoint || endpoint.length > WEB_PUSH_MAX_ENDPOINT_LENGTH) {
    return false;
  }
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidWebPushKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= WEB_PUSH_MAX_KEY_LENGTH;
}

export function webPushSubscriptionFromRow(
  row: Pick<
    WebPushSubscriptionRow,
    "subscription_id" | "endpoint" | "p256dh" | "auth" | "created_at_ms" | "updated_at_ms"
  >,
): WebPushSubscription {
  return {
    subscriptionId: row.subscription_id,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

export function boundWebPushSubscriptionFromRow(
  row: WebPushSubscriptionRow,
): BoundWebPushSubscription | null {
  if (!row.device_id) {
    return null;
  }
  return {
    ...webPushSubscriptionFromRow(row),
    deviceId: row.device_id,
    userProfileId: row.user_profile_id,
    devicePreferences: normalizeWebPushDevicePreferences(safeParseJson(row.preferences_json ?? "")),
  };
}

export function webPushSubscriptionToRow(params: {
  endpointHash: string;
  subscription: WebPushSubscription;
  binding?: { deviceId: string; userProfileId: string | null };
}): WebPushSubscriptionInsert {
  return {
    endpoint_hash: params.endpointHash,
    subscription_id: params.subscription.subscriptionId,
    endpoint: params.subscription.endpoint,
    p256dh: params.subscription.keys.p256dh,
    auth: params.subscription.keys.auth,
    device_id: params.binding?.deviceId ?? null,
    user_profile_id: params.binding?.userProfileId ?? null,
    preferences_json: null,
    created_at_ms: params.subscription.createdAtMs,
    updated_at_ms: params.subscription.updatedAtMs,
  };
}

export function webPushSubscriptionsEqual(
  left: WebPushSubscription,
  right: WebPushSubscription,
): boolean {
  return (
    left.subscriptionId === right.subscriptionId &&
    left.endpoint === right.endpoint &&
    left.keys.p256dh === right.keys.p256dh &&
    left.keys.auth === right.keys.auth &&
    left.createdAtMs === right.createdAtMs &&
    left.updatedAtMs === right.updatedAtMs
  );
}

export class WebPushSubscriptionBindingError extends Error {}
