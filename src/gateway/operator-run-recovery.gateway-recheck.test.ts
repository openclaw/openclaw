import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  type GatewayClientId,
  type GatewayClientMode,
} from "../../packages/gateway-protocol/src/client-info.js";
import { recordScheduledCommandRequester } from "../agents/plugin-scheduled-command.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { readCommandsAllowFromSender } from "../auto-reply/commands-allow-from.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCommandRequester } from "../cron/types.js";
import {
  captureActivePluginRegistrySnapshot,
  rollbackStagedPluginRegistry,
  stageActivePluginRegistry,
} from "../plugins/runtime.js";
import { prepareUserProfileIdentity } from "../state/user-profile-list.js";
import { ensureGatewayOwnerProfile, ensureProfileForEmail } from "../state/user-profiles.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { captureGatewayOperatorRecoverySnapshot } from "./operator-run-recovery-source.js";
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

/** A live command from this client, and the record its schedule keeps beside the source. */
function recordFromLive(
  client: RecoveryFixture["client"],
  snapshot: unknown,
  route: { channel?: string; accountId?: string } = {},
) {
  const live = Object.assign(
    resolveChatSendCallerContext(client, client.connect.client, route.channel),
    route.accountId ? { AccountId: route.accountId } : {},
  );
  const stored = recordScheduledCommandRequester(
    decodeReleasedShape(snapshot),
    readCommandsAllowFromSender(live),
  );
  return { live, stored };
}

/** Restore the stored source and resolve the occurrence's requester as the scheduled run does. */
async function restoreRequester(
  fixture: RecoveryFixture,
  stored: PluginCommandRequester | undefined,
  channel = "webchat",
) {
  const operatorSource = decodeReleasedShape(fixture.snapshot);
  const restored = await restoreGatewayQueuedOperatorRecovery({
    source: operatorSource,
    context: fixture.context,
    assertCurrent: () => {},
  });
  try {
    return resolveScheduledCommandRequester({ stored, operatorSource, channel, restored });
  } finally {
    restored.release();
  }
}

const allowFromConfig = (allowFrom?: Record<string, string[]>): OpenClawConfig =>
  allowFrom ? { commands: { allowFrom } } : {};

/** Each matrix row: the occurrence decides exactly as the live command did; both outcomes occur. */
function expectLiveParity(
  live: Parameters<typeof resolveCommandAuthorization>[0]["ctx"],
  requester: ReturnType<typeof resolveScheduledCommandRequester>,
  matrix: Array<Record<string, string[]> | undefined>,
) {
  const outcomes = matrix.map((allowFrom) => {
    const cfg = allowFromConfig(allowFrom);
    const liveAuthorized = resolveCommandAuthorization({
      ctx: live,
      cfg,
      commandAuthorized: true,
    }).isAuthorizedSender;
    expect(isScheduledOccurrenceCommandAuthorized(cfg, requester), JSON.stringify(allowFrom)).toBe(
      liveAuthorized,
    );
    return liveAuthorized;
  });
  // The matrix exercises both outcomes, so parity is not vacuous.
  expect(outcomes).toContain(true);
  expect(outcomes).toContain(false);
  return outcomes;
}

describe("gateway person occurrence rechecks commands.allowFrom as the live command did", () => {
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
          // An operator UI has no client sender id: the profileId is its only command sender.
          const { stored } = recordFromLive(fixture.client, fixture.snapshot);
          expect(stored).toEqual({ commandSenderId: profile.id });
          const requester = expectDefined(
            await restoreRequester(fixture, stored),
            "re-checkable gateway requester",
          );
          expect(requester).toEqual({ channel: "webchat", commandSenderId: profile.id });
          // An internal command resolves no provider: the "" list, else "*", gates it.
          const authorized = (allowFrom?: Record<string, string[]>) =>
            isScheduledOccurrenceCommandAuthorized(allowFromConfig(allowFrom), requester);
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

  it("re-checks a schedule routed with an external origin with the route's account", async () => {
    await withRecovery(
      async (fixture, _stateDir, profile) => {
        // A channel formatter may read the account: this one maps an alias on one account only.
        const plugin = createChannelTestPluginBase({
          id: "telegram",
          config: {
            formatAllowFrom: ({
              allowFrom,
              accountId,
            }: {
              allowFrom: Array<string | number>;
              accountId?: string | null;
            }) =>
              allowFrom.map((entry) =>
                String(entry) === "alias-person" && accountId === "route-account"
                  ? profile.id
                  : String(entry).trim(),
              ),
          },
        }) as ChannelPlugin;
        const previous = captureActivePluginRegistrySnapshot();
        stageActivePluginRegistry(
          createTestRegistry([{ pluginId: "telegram", plugin, source: "test" }]),
          null,
          "default",
        );
        try {
          const matrix: Array<Record<string, string[]> | undefined> = [
            undefined,
            { "*": [profile.id] },
            { "*": ["other-operator"] },
            { telegram: [profile.id] },
            { telegram: ["alias-person"] },
            { telegram: ["123456"], "*": [profile.id] },
            { telegram: ["*"] },
            { telegram: [] },
            { "": [profile.id] },
          ];
          const aliasRow = matrix.findIndex((row) => row?.telegram?.[0] === "alias-person");
          for (const accountId of ["route-account", "other-account"]) {
            // A TUI command delivered into a channel session carries that route, account included.
            const { live, stored } = recordFromLive(fixture.client, fixture.snapshot, {
              channel: "telegram",
              accountId,
            });
            expect(stored).toEqual({ commandSenderId: profile.id, accountId });
            const requester = expectDefined(
              await restoreRequester(fixture, stored, "telegram"),
              "re-checkable gateway requester",
            );
            const outcomes = expectLiveParity(live, requester, matrix);
            // The account decides the alias row, so the stored account is load-bearing.
            expect(outcomes[aliasRow]).toBe(accountId === "route-account");
          }
        } finally {
          rollbackStagedPluginRegistry(previous);
        }
      },
      { clientInfo: { id: GATEWAY_CLIENT_IDS.TUI, mode: "cli" } },
    );
  });

  it("re-checks a person on a non-operator-UI client with both live sender candidates", async () => {
    await withRecovery(
      async (fixture, _stateDir, profile) => {
        // Live, a signed-in person on a CLI is matched by its client id and by the profileId.
        const { live, stored } = recordFromLive(fixture.client, fixture.snapshot);
        expect(stored).toEqual({ commandSenderId: profile.id, senderId: GATEWAY_CLIENT_IDS.CLI });
        const requester = expectDefined(
          await restoreRequester(fixture, stored),
          "re-checkable gateway requester",
        );
        const matrix: Array<Record<string, string[]> | undefined> = [
          undefined,
          { "*": [profile.id] },
          { "*": [GATEWAY_CLIENT_IDS.CLI] },
          { "*": ["other-operator"] },
          { "*": [] },
          { "": [GATEWAY_CLIENT_IDS.CLI] },
          { "": [], "*": [profile.id] },
        ];
        const outcomes = expectLiveParity(live, requester, matrix);
        // Narrowed past both candidates, the occurrence is refused as live would be.
        expect(outcomes[3]).toBe(false);
        expect(outcomes[2]).toBe(true);
      },
      { clientInfo: { id: GATEWAY_CLIENT_IDS.CLI, mode: "cli" } },
    );
  });

  it("keeps a client without a live command sender on its original admission", async () => {
    await withRecovery(
      async (fixture) => {
        // No live profile sender (shared-secret owner): nothing is recorded, nothing invented.
        expect(recordFromLive(fixture.client, fixture.snapshot).stored).toBeUndefined();
        expect(await restoreRequester(fixture, undefined)).toBeUndefined();
      },
      { withoutCommandSender: true },
    );
  });

  it("keeps a schedule stored without the command sender on its original admission", async () => {
    // Accepted by an older build, or from an authority rebuilt from a snapshot (no live client).
    await withRecovery(async (fixture) => {
      const requester = await restoreRequester(fixture, undefined);
      expect(requester).toBeUndefined();
      const narrowed = allowFromConfig({ "*": ["other-operator"] });
      expect(isScheduledOccurrenceCommandAuthorized(narrowed, requester)).toBe(true);
    });
  });

  it("records only the stored source's person", async () => {
    await withRecovery(async (fixture, _stateDir, profile) => {
      const source = decodeReleasedShape(fixture.snapshot);
      expect(recordScheduledCommandRequester(source, { commandSenderId: "other-operator" })).toBe(
        undefined,
      );
      expect(recordScheduledCommandRequester(source, { senderId: "cli" })).toBeUndefined();
      const channelSource = { kind: "channel", snapshot: {} } as unknown as typeof source;
      expect(
        recordScheduledCommandRequester(channelSource, { commandSenderId: profile.id }),
      ).toBeUndefined();
    });
  });

  it("fails closed when the stored command sender is not the source's person", async () => {
    await withRecovery(async (fixture, _stateDir, profile) => {
      await expect(
        restoreRequester(fixture, { commandSenderId: "other-operator" }),
      ).rejects.toThrow("requester changed");
      const operatorSource = decodeReleasedShape(fixture.snapshot);
      const stored = { commandSenderId: profile.id, senderId: "cli", accountId: "a1" };
      const resolve = (
        source: Parameters<typeof resolveScheduledCommandRequester>[0]["operatorSource"],
        authorityProfileId: string,
      ) =>
        resolveScheduledCommandRequester({
          stored,
          operatorSource: source,
          channel: "telegram",
          restored: { authority: { ...fixture.sourceAuthority, profileId: authorityProfileId } },
        });
      // The record is replayed whole, on the schedule's channel.
      expect(resolve(operatorSource, profile.id)).toEqual({ ...stored, channel: "telegram" });
      // The restored authority must be the same person, and only a Gateway source carries it.
      expect(() => resolve(operatorSource, "other-operator")).toThrow("requester changed");
      const channelSource = { kind: "channel", snapshot: {} } as unknown as typeof operatorSource;
      expect(() => resolve(channelSource, profile.id)).toThrow("requester changed");
    });
  });

  it("selects the same commands.allowFrom list as a live command from the same client", async () => {
    await withRecovery(async (fixture, _stateDir, profile) => {
      const { live, stored } = recordFromLive(fixture.client, fixture.snapshot);
      const requester = expectDefined(
        await restoreRequester(fixture, stored),
        "re-checkable gateway requester",
      );
      expectLiveParity(live, requester, [
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
      ]);
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

describe("remote Gateway schedule source round-trips through the production restore", () => {
  it.each([
    {
      label: "person, remote Control UI",
      kind: "person",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      senderId: undefined,
    },
    {
      label: "owner, remote Control UI",
      kind: "owner",
      id: GATEWAY_CLIENT_IDS.CONTROL_UI,
      senderId: undefined,
    },
    {
      label: "person, host-side request",
      kind: "person",
      id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
      senderId: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    },
  ] as const)("$label", ({ kind, id, senderId }) =>
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
      let recorded: ReturnType<typeof recordFromLive>;
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
        recorded = recordFromLive(client, snapshot);
        // A person's live profile sender is recorded with their client id; an owner has none.
        expect(recorded.stored).toEqual(
          kind === "person"
            ? { commandSenderId: profileId, ...(senderId ? { senderId } : {}) }
            : undefined,
        );
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
            stored: recorded.stored,
            operatorSource,
            channel: "webchat",
            restored,
          });
          const matrix = [[profileId], [GATEWAY_CLIENT_IDS.GATEWAY_CLIENT], ["other-operator"], []];
          if (kind === "person") {
            // The occurrence refuses exactly when a live command from this client would.
            expectLiveParity(
              recorded.live,
              requester,
              matrix.map((allowFrom) => ({ "*": allowFrom })),
            );
          } else {
            expect(requester).toBeUndefined();
            for (const allowFrom of matrix) {
              expect(
                isScheduledOccurrenceCommandAuthorized(
                  allowFromConfig({ "*": allowFrom }),
                  requester,
                ),
              ).toBe(true);
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
