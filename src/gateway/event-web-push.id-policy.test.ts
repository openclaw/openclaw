import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BoundWebPushSubscription } from "../infra/push-web.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { createEventWebPushDelivery } from "./event-web-push.js";
import { setDeviceTokenBindingOwner } from "./openclaw-id/device-token-binding.js";
import {
  setOpenClawIdTunnelPrincipalLookup,
  type OpenClawIdTunnelPrincipal,
} from "./openclaw-id/tunnel-principal.js";

const mocks = vi.hoisted(() => ({ subscriptions: vi.fn(), paired: vi.fn(), send: vi.fn() }));
let authorityCompleted = createDeferred();

// mock-isolation: Select synthetic paired subscriptions and capture provider delivery;
// membership, profiles, role policy and session visibility use their real owners.
vi.mock("../infra/push-web.js", () => ({
  withBoundWebPushSubscriptions: (async (_stateDir, prepare) => {
    try {
      return (await prepare(mocks.subscriptions(), () => {}))?.start();
    } finally {
      authorityCompleted.resolve();
    }
  }) satisfies typeof import("../infra/push-web.js").withBoundWebPushSubscriptions,
  hasBoundWebPushSubscriptions: async () => true,
  prepareWebPushNotificationSender: async () => mocks.send,
}));
vi.mock("../infra/device-pairing-worker.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/device-pairing-worker.js")>()),
  withCurrentDevicePairingSnapshot: (async (_stateDir, prepare, preparePublication) => {
    await preparePublication?.();
    return prepare(mocks.paired())?.start();
  }) satisfies typeof import("../infra/device-pairing-worker.js").withCurrentDevicePairingSnapshot,
}));

function makeSubscription(deviceId: string, userProfileId: string): BoundWebPushSubscription {
  return {
    subscriptionId: `subscription-${deviceId}`,
    endpoint: `https://push.example.test/${deviceId}`,
    keys: { p256dh: "synthetic-key", auth: "synthetic-auth" },
    createdAtMs: 1,
    updatedAtMs: 1,
    deviceId,
    userProfileId,
    devicePreferences: { enabled: true, label: "", categories: { agentFinished: true } },
  };
}
function pairedOperator(deviceId: string, scopes: string[]) {
  return {
    deviceId,
    roles: ["operator"],
    approvedScopes: scopes,
    tokens: { operator: { role: "operator", scopes } },
  };
}
const setSubscriptions = (...subscriptions: BoundWebPushSubscription[]) =>
  mocks.subscriptions.mockReturnValue(subscriptions);
const setPaired = (...paired: ReturnType<typeof pairedOperator>[]) =>
  mocks.paired.mockReturnValue(paired);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.send.mockResolvedValue([]);
  authorityCompleted = createDeferred();
});
afterEach(() => {
  setDeviceTokenBindingOwner(undefined);
  setOpenClawIdTunnelPrincipalLookup(undefined);
});

describe("Web Push ID membership policy", () => {
  it.each([
    "none",
    "view",
    "unknown role",
    "removed",
    "off",
    "scope removed",
    "definitions only",
    "owner",
  ] as const)(
    "uses current ID membership instead of the linked profile for completion delivery: %s",
    async (membership) => {
      await withOpenClawTestState({ scenario: "minimal" }, async () => {
        const creator = ensureProfileForEmail("push-creator@example.test");
        const recipient = ensureProfileForEmail("push-recipient@example.test");
        setUserProfileRole(recipient.id, membership === "owner" ? "restricted" : "admin");
        const cfg: OpenClawConfig = {
          gateway: {
            roles: {
              ...(membership === "definitions only" ? {} : { default: "restricted" }),
              definitions: {
                admin: { scopes: ["operator.admin"], sessions: { others: "write" }, agents: "*" },
                restricted: {
                  scopes: ["operator.read"],
                  sessions: { others: "none" },
                  agents: "*",
                },
                member: {
                  scopes: membership === "scope removed" ? [] : ["operator.read"],
                  sessions: {
                    others:
                      membership === "view" || membership === "scope removed" ? "view" : "none",
                  },
                  agents: "*",
                },
              },
            },
          },
        };
        setRuntimeConfigSnapshot(cfg);
        const sessionKey = "agent:main:foreign-push";
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey },
          {
            sessionId: "foreign-push",
            updatedAt: 1,
            createdActor: { type: "human", source: "profile", id: creator.id },
          },
        );
        const idBrowser = makeSubscription("id-browser", recipient.id);
        const localBrowser = makeSubscription("local-browser", recipient.id);
        setSubscriptions(idBrowser, localBrowser);
        setPaired(
          pairedOperator("id-browser", ["operator.admin"]),
          pairedOperator("local-browser", ["operator.admin"]),
        );
        const peerKey = `iroh:${"a".repeat(64)}`;
        setDeviceTokenBindingOwner({
          lookup: (deviceId) => (deviceId === "id-browser" ? peerKey : undefined),
          record: async () => {},
          forget: async () => {},
          reportMismatch: () => {},
        });
        const principal: OpenClawIdTunnelPrincipal =
          membership === "owner"
            ? { kind: "owner", peerKey }
            : {
                kind: "member",
                peerKey,
                accountId: "account",
                role: membership === "unknown role" ? "missing" : "member",
              };
        setOpenClawIdTunnelPrincipalLookup(
          membership === "off"
            ? undefined
            : () => (membership === "removed" ? undefined : principal),
        );
        createEventWebPushDelivery(() => cfg).handleEvent(
          "chat",
          { state: "final", runId: "membership-run" },
          { agentId: "main", sessionKeys: [sessionKey] },
        );
        await authorityCompleted.promise;
        expect(mocks.send).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            subscriptions:
              membership === "owner"
                ? [idBrowser]
                : membership === "view"
                  ? [idBrowser, localBrowser]
                  : [localBrowser],
          }),
        );
      });
    },
  );
});
