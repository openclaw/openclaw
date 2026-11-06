import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  GATEWAY_CLIENT_IDS,
  type GatewayClientId,
  type GatewayClientMode,
} from "../../packages/gateway-protocol/src/client-info.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { decodeQueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { restoreGatewayQueuedOperatorRecovery } from "./operator-run-recovery.js";
import {
  type createOperatorRecoveryFixture,
  pairedOperator,
  recoveryFixture,
} from "./operator-run-recovery.test-support.js";
import { isScheduledOccurrenceCommandAuthorized } from "./plugin-command-scheduled-run.js";
import { resolveChatSendCallerContext } from "./server-methods/gateway-client-identity.js";

type RecoveryFixture = Awaited<ReturnType<typeof recoveryFixture>>;

function withRecovery(
  run: (
    fixture: RecoveryFixture,
    stateDir: string,
    profile: ReturnType<typeof ensureProfileForEmail>,
  ) => Promise<void>,
  overrides: Partial<Parameters<typeof createOperatorRecoveryFixture>[0]> = {},
) {
  return withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
    const profile = ensureProfileForEmail("recovery@example.test");
    await run(
      await recoveryFixture(stateDir, profile.id, { device: pairedOperator(), ...overrides }),
      stateDir,
      profile,
    );
  });
}

async function restoreRequester(fixture: RecoveryFixture, snapshot: object = fixture.snapshot) {
  const persisted: unknown = structuredClone({ kind: "gateway", snapshot });
  const resumed = await restoreGatewayQueuedOperatorRecovery({
    source: decodeQueuedOperatorRecoverySource(persisted),
    context: fixture.context,
    assertCurrent: () => {},
  });
  try {
    return resumed.requester;
  } finally {
    resumed.release();
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
          // Live, the profileId was this surface's only command sender.
          expect(fixture.snapshot.commandSenderProfileIdOnly).toBe(true);
          const requester = expectDefined(
            await restoreRequester(fixture),
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
    await withRecovery(async (fixture) => {
      expect(fixture.snapshot.commandSenderProfileIdOnly).toBe(true);
      const requester = await restoreRequester(fixture);
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
        expect(fixture.snapshot).not.toHaveProperty("commandSenderProfileIdOnly");
        expect(await restoreRequester(fixture)).toBeUndefined();
      },
      { withoutCommandSender: true },
    );
  });

  it("keeps a non-operator-UI gateway occurrence on its original admission", async () => {
    await withRecovery(
      async (fixture) => {
        // A non-UI client is matched live by a content sender id, which is not re-checkable here.
        expect(fixture.snapshot).not.toHaveProperty("commandSenderProfileIdOnly");
        expect(await restoreRequester(fixture)).toBeUndefined();
      },
      { clientInfo: { id: GATEWAY_CLIENT_IDS.CLI, mode: "cli" } },
    );
  });

  it("keeps a pre-marker gateway snapshot on its original admission", async () => {
    // A schedule accepted before the marker existed reads back without the fact.
    await withRecovery(async (fixture) => {
      const legacy: Record<string, unknown> = { ...fixture.snapshot };
      delete legacy.commandSenderProfileIdOnly;
      expect(await restoreRequester(fixture, legacy)).toBeUndefined();
    });
  });

  it("selects the same commands.allowFrom list as a live command from the same client", async () => {
    await withRecovery(async (fixture, _stateDir, profile) => {
      const requester = expectDefined(
        await restoreRequester(fixture),
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
