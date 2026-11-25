// Every saved-requester start needs its creation grant now: chat needs write, Talk consults need
// talk, and scheduled automations need cron or write. In-run continuations and channels need none.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { GatewayOperatorRecoveryAuthorizationError } from "../infra/restart-recovery-errors.js";
import { setUserProfileRole } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import {
  captureGatewayOperatorContinuation,
  restoreGatewayOperatorSource,
  restoreGatewayQueuedOperatorRecovery,
  restoreScheduledAutomationOperator,
  restoreTalkConsultOperator,
} from "./operator-run-recovery.js";
import { recoveryFixture, type RecoveryFixture } from "./operator-run-recovery.test-support.js";

const scope = (scopes: GatewayOperatorRoleDefinition["scopes"]): GatewayOperatorRoleDefinition => ({
  scopes,
  agents: "*",
  sessions: { others: "none" },
});
const roles = {
  default: "reader",
  definitions: {
    writer: scope(["operator.read", "operator.write"]),
    reader: scope(["operator.read"]),
    scheduler: scope(["operator.cron"]),
    talker: scope(["operator.read", "operator.talk"]),
  },
} satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
type Role = keyof typeof roles.definitions;
type Start = (
  fixture: RecoveryFixture,
) => Promise<{ authority: { scopes: readonly string[] }; release: () => void }>;

const queued = (fixture: RecoveryFixture) =>
  ({
    source: { kind: "gateway", snapshot: fixture.snapshot },
    agentId: fixture.target.agentId,
    context: fixture.context,
    assertCurrent: () => {},
  }) as const;
const chatStart: Start = (fixture) => restoreGatewayQueuedOperatorRecovery(queued(fixture));
const automationStart: Start = (fixture) => restoreScheduledAutomationOperator(queued(fixture));

// Each kind uses the entry its producer uses, with the saved-source shape it stores.
const chatKinds: Array<[string, Start]> = [
  [
    "queued chat, /followup, collected batch and Goal successor",
    (fixture) =>
      restoreGatewayQueuedOperatorRecovery({
        ...queued(fixture),
        source: captureQueuedOperatorRecoverySource(fixture.sourceAuthority),
        liveAuthority: fixture.sourceAuthority,
      }),
  ],
  ["restart replay of a queued chat input", chatStart],
  [
    "plugin service session work accepted in a chat turn",
    (fixture) =>
      restoreGatewayOperatorSource({
        snapshot: fixture.snapshot,
        agentId: fixture.target.agentId,
        context: fixture.context,
        assertCurrent: () => {},
      }),
  ],
];
const automationKinds: Array<[string, Start]> = [
  ["cron agent turn, command and script", automationStart],
  [
    "plugin service session work accepted in a cron run",
    (fixture) => restoreScheduledAutomationOperator(queued(fixture)),
  ],
];

async function withRequester(
  email: string,
  role: Role,
  run: (fixture: RecoveryFixture, setRole: (next: Role) => void) => Promise<void>,
) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const profile = ensureProfileForEmail(email);
    setUserProfileRole(profile.id, role);
    const fixture = await recoveryFixture(state.stateDir, profile.id, {
      config: { gateway: { roles } },
      scopes: [...roles.definitions[role].scopes],
    });
    await run(fixture, (next) => setUserProfileRole(profile.id, next));
  });
}

describe("saved requester start grant", () => {
  it.each(
    chatKinds.flatMap(([kind, start]) => [
      [kind, "reader", start] as const,
      [kind, "scheduler", start] as const,
      [kind, "talker", start] as const,
    ]),
  )("refuses %s after the writer becomes %s", (_kind, role, start) =>
    withRequester("chat-start@example.test", "writer", async (fixture, setRole) => {
      (await start(fixture)).release();
      setRole(role);
      await expect(start(fixture)).rejects.toThrow(GatewayOperatorRecoveryAuthorizationError);
    }),
  );

  it("starts a queued Talk consult for a read and talk creator", () =>
    withRequester("talk-start@example.test", "talker", async (fixture, setRole) => {
      const start = () =>
        restoreTalkConsultOperator({
          ...queued(fixture),
          source: captureQueuedOperatorRecoverySource(fixture.sourceAuthority),
          liveAuthority: fixture.sourceAuthority,
        });
      const admitted = await start();
      expect(admitted.authority.scopes).toEqual(["operator.read", "operator.talk"]);
      admitted.release();
      setRole("reader");
      await expect(start()).rejects.toThrow(GatewayOperatorRecoveryAuthorizationError);
    }));

  it.each(automationKinds)("admits %s for a cron-only creator", (_kind, start) =>
    withRequester("cron-creator@example.test", "scheduler", async (fixture) => {
      const admitted = await start(fixture);
      try {
        expect(admitted.authority.scopes).toEqual(["operator.cron"]);
      } finally {
        admitted.release();
      }
    }),
  );

  it.each(automationKinds)("refuses %s after its creator becomes read-only", (_kind, start) =>
    withRequester("automation-reader@example.test", "writer", async (fixture, setRole) => {
      (await start(fixture)).release();
      setRole("reader");
      await expect(start(fixture)).rejects.toThrow(GatewayOperatorRecoveryAuthorizationError);
    }),
  );

  it("keeps an in-run continuation of a requester made read-only", () =>
    withRequester("continuation@example.test", "writer", async (fixture, setRole) => {
      setRole("reader");
      const continuation = expectDefined(
        await captureGatewayOperatorContinuation({
          client: {
            ...fixture.client,
            internal: { ...fixture.client.internal, operatorRunAuthority: fixture.sourceAuthority },
          },
          context: fixture.context,
          agentId: fixture.target.agentId,
        }),
        "in-run continuation",
      );
      try {
        expect(continuation.authority.scopes).toEqual(["operator.read"]);
      } finally {
        continuation.release();
      }
    }));

  it("keeps a queued message from a read-only channel sender", () =>
    withAdminIngress(async ({ admins, activatePolicy, cfg, context, gateway }) => {
      const member = expectDefined(admins[0], "linked member");
      const channelRoles = expectDefined(cfg.gateway?.roles, "configured channel roles");
      await activatePolicy({
        roles: {
          ...channelRoles,
          definitions: {
            ...channelRoles.definitions,
            viewer: { scopes: ["operator.read"], agents: "*", sessions: { others: "view" } },
          },
        },
      });
      setUserProfileRole(member.profile.id, "viewer");
      const original = expectDefined(
        prepareInternalGetReplyOptions(undefined, await context(member.identity.senderId))
          ?.operatorAuthority,
        "verified channel sender authority",
      );
      const restored = await restoreGatewayQueuedOperatorRecovery({
        source: captureQueuedOperatorRecoverySource(original),
        context: gateway,
        assertCurrent: () => {},
      });
      try {
        expect(restored.authority.scopes).toEqual(["operator.read"]);
      } finally {
        restored.release();
      }
    }));
});
