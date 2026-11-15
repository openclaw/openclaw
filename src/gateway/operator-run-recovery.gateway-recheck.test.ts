import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  type GatewayClientId,
  type GatewayClientMode,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import {
  captureGatewayOperatorRecoverySnapshot,
  resolveLiveProfileCommandSender,
} from "./operator-run-recovery-source.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import { type RecoveryFixture, withRecovery } from "./operator-run-recovery.test-support.js";
import {
  isScheduledOccurrenceCommandAuthorized,
  resolveScheduledCommandRequester,
} from "./plugin-command-scheduled-run.js";
import { createRemoteControlUiIngressTestContext } from "./remote-control-ui.test-support.js";
import { registerIngressPrincipalRecovery } from "./remote-ingress-principal-recovery.js";
import { resolveChatSendCallerContext } from "./server-methods/gateway-client-identity.js";
import {
  createContext,
  createOperatorClient,
} from "./server-plugin-in-process-dispatch.test-support.js";

/** The persisted source reads back unchanged through the strict codec current main ships. */
function decodeReleasedShape(snapshot: unknown) {
  const source = decodeQueuedOperatorRecoverySource(structuredClone({ kind: "gateway", snapshot }));
  expect(source).toEqual({ kind: "gateway", snapshot });
  if (source.kind !== "gateway") {
    throw new Error("expected a gateway source");
  }
  return source;
}

/** Restore the stored source and resolve the occurrence's requester as the scheduled run does. */
async function restoreRequester(fixture: RecoveryFixture, storedSender: string | undefined) {
  const operatorSource = decodeReleasedShape(fixture.snapshot);
  const restored = await restoreGatewayQueuedOperatorRecovery({
    source: operatorSource,
    context: fixture.context,
    assertCurrent: () => {},
  });
  try {
    return resolveScheduledCommandRequester({ storedSender, operatorSource, restored });
  } finally {
    restored.release();
  }
}

const allowFromConfig = (allowFrom?: Record<string, string[]>): OpenClawConfig =>
  allowFrom ? { commands: { allowFrom } } : {};

describe("gateway operator-UI occurrence rechecks commands.allowFrom", () => {
  it.each<{ label: string; id: GatewayClientId; mode: GatewayClientMode; scopes: string[] }>([
    {
      label: "Control UI admin",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: "webchat",
      scopes: ["operator.admin"],
    },
    {
      label: "Control UI non-admin",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      mode: "webchat",
      scopes: ["operator.read", "operator.write"],
    },
    {
      label: "browser copilot",
      id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT,
      mode: "webchat",
      scopes: ["operator.admin"],
    },
    { label: "TUI", id: GATEWAY_CLIENT_IDS.TUI, mode: "cli", scopes: ["operator.admin"] },
  ])(
    "re-checks the internal commands.allowFrom list against the profileId for a $label schedule",
    async ({ id, mode, scopes }) => {
      await withRecovery(
        async (fixture, _stateDir, profile) => {
          // Live, the profileId was this surface's only command sender; kept beside the snapshot.
          expect(fixture.sourceAuthority.commandSenderProfileId).toBe(profile.id);
          const requester = expectDefined(
            await restoreRequester(fixture, fixture.sourceAuthority.commandSenderProfileId),
            "re-checkable gateway requester",
          );
          expect(requester).toEqual({ channel: "webchat", commandSenderId: profile.id });
          // An internal command resolves no provider: the "" list, else "*", gates it.
          const authorized = (allowFrom?: Record<string, string[]>) =>
            isScheduledOccurrenceCommandAuthorized(
              allowFromConfig(allowFrom),
              requester,
              "webchat",
            );
          expect(authorized({ "*": [profile.id] })).toBe(true);
          expect(authorized({ "*": ["other-operator"] })).toBe(false);
          expect(authorized({ "*": [] })).toBe(false);
          expect(authorized({ "": [], "*": [profile.id] })).toBe(false);
          // The live path never reads a "webchat" key for an internal command.
          expect(authorized({ webchat: ["other-operator"] })).toBe(true);
          expect(authorized()).toBe(true);
        },
        { clientInfo: { id, mode }, scopes },
      );
    },
  );

  it("keeps a schedule routed with an external origin on its original admission", async () => {
    await withRecovery(async (fixture, _stateDir, profile) => {
      expect(fixture.sourceAuthority.commandSenderProfileId).toBe(profile.id);
      const requester = await restoreRequester(
        fixture,
        fixture.sourceAuthority.commandSenderProfileId,
      );
      const narrowed = allowFromConfig({ "*": ["other-operator"] });
      expect(isScheduledOccurrenceCommandAuthorized(narrowed, requester, "webchat")).toBe(false);
      // Live authorization used that channel's list and account, which the recovery does not carry.
      expect(isScheduledOccurrenceCommandAuthorized(narrowed, requester, "telegram")).toBe(true);
    });
  });

  it("keeps a client without a live command sender on its original admission", async () => {
    await withRecovery(
      async (fixture) => {
        // No live sender candidate (shared-secret owner): the recovery must not invent one.
        expect(fixture.sourceAuthority.commandSenderProfileId).toBeUndefined();
        expect(
          await restoreRequester(fixture, fixture.sourceAuthority.commandSenderProfileId),
        ).toBeUndefined();
      },
      { withoutCommandSender: true },
    );
  });

  it("keeps a non-operator-UI gateway occurrence on its original admission", async () => {
    await withRecovery(
      async (fixture) => {
        // A non-UI client is matched live by a content sender id, which is not re-checkable here.
        expect(fixture.sourceAuthority.commandSenderProfileId).toBeUndefined();
        expect(
          await restoreRequester(fixture, fixture.sourceAuthority.commandSenderProfileId),
        ).toBeUndefined();
      },
      { clientInfo: { id: GATEWAY_CLIENT_IDS.CLI, mode: "cli" } },
    );
  });

  it("keeps a schedule stored without the command sender on its original admission", async () => {
    // Accepted by an older build, or from an authority rebuilt from a snapshot (no live client).
    await withRecovery(async (fixture) => {
      const requester = await restoreRequester(fixture, undefined);
      expect(requester).toBeUndefined();
      const narrowed = allowFromConfig({ "*": ["other-operator"] });
      expect(isScheduledOccurrenceCommandAuthorized(narrowed, requester, "webchat")).toBe(true);
    });
  });

  it("fails closed when the stored command sender is not the source's person", async () => {
    await withRecovery(async (fixture, _stateDir, profile) => {
      await expect(restoreRequester(fixture, "other-operator")).rejects.toThrow(
        "requester changed",
      );
      const operatorSource = decodeReleasedShape(fixture.snapshot);
      const resolve = (
        source: Parameters<typeof resolveScheduledCommandRequester>[0]["operatorSource"],
        authorityProfileId: string,
      ) =>
        resolveScheduledCommandRequester({
          storedSender: profile.id,
          operatorSource: source,
          restored: { authority: { ...fixture.sourceAuthority, profileId: authorityProfileId } },
        });
      expect(resolve(operatorSource, profile.id)).toEqual({
        channel: "webchat",
        commandSenderId: profile.id,
      });
      // The restored authority must be the same person, and only a Gateway source carries it.
      expect(() => resolve(operatorSource, "other-operator")).toThrow("requester changed");
      const channelSource = { kind: "channel", snapshot: {} } as unknown as typeof operatorSource;
      expect(() => resolve(channelSource, profile.id)).toThrow("requester changed");
    });
  });

  it("selects the same commands.allowFrom list as a live command from the same client", async () => {
    await withRecovery(async (fixture, _stateDir, profile) => {
      const requester = expectDefined(
        await restoreRequester(fixture, fixture.sourceAuthority.commandSenderProfileId),
        "re-checkable gateway requester",
      );
      const live = resolveChatSendCallerContext(fixture.client);
      const matrix: Array<Record<string, string[]> | undefined> = [
        undefined,
        { "*": [profile.id] },
        { "*": ["other-operator"] },
        { "*": [] },
        { "*": ["*"] },
        { "": [profile.id] },
        { "": [], "*": [profile.id] },
        { webchat: [], "*": [profile.id] },
        { webchat: ["*"], "*": [] },
        { webchat: [profile.id] },
      ];
      const outcomes = matrix.map((allowFrom) => {
        const cfg = allowFromConfig(allowFrom);
        const liveAuthorized = resolveCommandAuthorization({
          ctx: live,
          cfg,
          commandAuthorized: true,
        }).isAuthorizedSender;
        expect(
          isScheduledOccurrenceCommandAuthorized(cfg, requester, "webchat"),
          JSON.stringify(allowFrom),
        ).toBe(liveAuthorized);
        return liveAuthorized;
      });
      // The matrix exercises both outcomes, so parity is not vacuous.
      expect(outcomes).toContain(true);
      expect(outcomes).toContain(false);
    });
  });
});

// A remote person needs trusted-proxy auth and named roles to resume, as on the live ingress.
const REMOTE_PERSON_CONFIG: OpenClawConfig = {
  gateway: {
    auth: {
      mode: "trusted-proxy",
      trustedProxy: {
        userHeader: "cf-access-authenticated-user-email",
        requiredHeaders: ["cf-access-jwt-assertion"],
      },
    },
    roles: {
      default: "writer",
      definitions: {
        writer: {
          scopes: ["operator.read", "operator.write"],
          agents: "*",
          sessions: { others: "none" },
        },
      },
    },
  },
};

describe("remote operator-UI schedule source round-trips through the production restore", () => {
  it.each([
    {
      label: "person, remote Control UI",
      kind: "person",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      recorded: true,
    },
    {
      label: "owner, remote Control UI",
      kind: "owner",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      recorded: false,
    },
    {
      label: "person, host-side request",
      kind: "person",
      id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
      recorded: false,
    },
  ] as const)("$label", ({ kind, id, recorded }) =>
    withOpenClawTestState({ scenario: "minimal" }, async () => {
      ensureGatewayOwnerProfile("Gateway owner");
      const profile = ensureProfileForEmail("remote@example.test");
      const principal = kind === "person" ? { kind, profileId: profile.id } : { kind };
      const resolved = createRemoteControlUiIngressTestContext({ principal }).resolvePrincipal();
      const recoverySource = { pluginId: "remote-ui-test", audienceId: "test-grant" };
      const remote = { ...resolved, recoverySource: { ...recoverySource, recoveryId: "r1" } };
      const profileId = remote.authenticatedUserProfile.profileId;
      // The client a remote browser peer gets: its own client id plus the ingress principal.
      const client = createOperatorClient({ profileId, scopes: ["operator.write"] });
      delete client.authenticatedUserId;
      client.connect.client.id = id;
      client.connect.client.mode = id === GATEWAY_CLIENT_IDS.CONTROL_UI ? "webchat" : "backend";
      client.internal = {
        remoteIngressPrincipal: remote,
        operatorRoleActor: remote.operatorRoleActor,
      };
      // The plugin's grant store outlives the peer; a restore resumes from it, never the client.
      const context = createContext([], () => REMOTE_PERSON_CONFIG);
      const owner = new AbortController();
      let granted = true;
      registerIngressPrincipalRecovery(context, recoverySource.pluginId, {
        resume: async (audienceId) =>
          granted && audienceId === recoverySource.audienceId
            ? {
                audienceId,
                recoveryId: "r1",
                principal,
                operatorScopeCeiling: [...remote.scopes],
                signal: owner.signal,
                assertCurrent: () => owner.signal.throwIfAborted(),
              }
            : undefined,
        signal: owner.signal,
        assertCurrent: () => owner.signal.throwIfAborted(),
      });
      const identity = await prepareUserProfileIdentity(profileId);
      let persisted: string;
      let storedSender: string | undefined;
      try {
        const snapshot = captureGatewayOperatorRecoverySnapshot({
          client,
          authority: {
            profileId,
            scopes: [...remote.scopes],
            gatewayAccessGrant: null,
            assertCurrent: () => {},
            openclawIdPrincipal: undefined,
          },
          modelPolicy: undefined,
          identity,
          config: REMOTE_PERSON_CONFIG,
        });
        expect(snapshot).toMatchObject({ sourceIngress: "principal", ingress: recoverySource });
        decodeReleasedShape(snapshot);
        storedSender = resolveLiveProfileCommandSender(client, profileId);
        expect(storedSender).toBe(recorded ? profileId : undefined);
        persisted = JSON.stringify({ kind: "gateway", snapshot });
      } finally {
        identity.release();
      }
      const operatorSource = decodeReleasedShape(JSON.parse(persisted).snapshot);
      const restore = () =>
        restoreGatewayQueuedOperatorRecovery({
          source: JSON.parse(persisted),
          context,
          assertCurrent: () => {},
        });
      try {
        const restored = await restore();
        try {
          const requester = resolveScheduledCommandRequester({
            storedSender,
            operatorSource,
            restored,
          });
          expect(requester).toEqual(
            recorded ? { channel: "webchat", commandSenderId: profileId } : undefined,
          );
          const live = resolveChatSendCallerContext(client);
          for (const allowFrom of [[profileId], ["other-operator"], []]) {
            const cfg = allowFromConfig({ "*": allowFrom });
            const liveAuthorized = resolveCommandAuthorization({
              ctx: live,
              cfg,
              commandAuthorized: true,
            }).isAuthorizedSender;
            // The occurrence refuses exactly when a live command from this client would.
            expect(isScheduledOccurrenceCommandAuthorized(cfg, requester, "webchat")).toBe(
              recorded ? liveAuthorized : true,
            );
            if (recorded) {
              expect(liveAuthorized).toBe(allowFrom[0] === profileId);
            }
          }
        } finally {
          restored.release();
        }
        granted = false;
        await expect(restore()).rejects.toThrow("original ingress grant");
      } finally {
        owner.abort();
      }
    }),
  );
});
