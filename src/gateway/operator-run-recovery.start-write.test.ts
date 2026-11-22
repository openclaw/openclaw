// Every saved-requester start shares one write requirement; in-run continuations and channel senders do not.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { prepareInternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { withAdminIngress } from "../channels/message-access/operator-authority.test-support.js";
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
} from "./operator-run-recovery.js";
import { recoveryFixture, type RecoveryFixture } from "./operator-run-recovery.test-support.js";

describe("saved requester start write grant", () => {
  const roles = {
    default: "reader",
    definitions: {
      writer: {
        scopes: ["operator.read", "operator.write"],
        agents: "*",
        sessions: { others: "none" },
      },
      reader: { scopes: ["operator.read"], agents: "*", sessions: { others: "none" } },
    },
  } satisfies NonNullable<NonNullable<OpenClawConfig["gateway"]>["roles"]>;
  type Start = (
    fixture: RecoveryFixture,
  ) => Promise<{ authority: { scopes: readonly string[] }; release: () => void }>;
  const savedSource = (fixture: RecoveryFixture) =>
    ({
      version: 1,
      kind: "gateway",
      agentId: fixture.target.agentId,
      sourceRunId: "scheduled-source-run",
      snapshot: fixture.snapshot,
    }) as const;
  const restoreSaved: Start = (fixture) =>
    restoreGatewayOperatorSource({
      snapshot: fixture.snapshot,
      source: savedSource(fixture),
      agentId: fixture.target.agentId,
      context: fixture.context,
      assertCurrent: () => {},
    });
  const restoreQueued: Start = (fixture) =>
    restoreGatewayQueuedOperatorRecovery({
      source: { kind: "gateway", snapshot: fixture.snapshot },
      agentId: fixture.target.agentId,
      context: fixture.context,
      assertCurrent: () => {},
    });
  const writerFixture = async (stateDir: string, email: string) => {
    const profile = ensureProfileForEmail(email);
    setUserProfileRole(profile.id, "writer");
    const fixture = await recoveryFixture(stateDir, profile.id, {
      config: { gateway: { roles } },
      scopes: ["operator.read", "operator.write"],
    });
    return { fixture, demote: () => setUserProfileRole(profile.id, "reader") };
  };

  // Each start kind uses the admission entry and saved-source shape its producer uses.
  it.each<[string, Start]>([
    [
      "queued followup, Goal successor and collected batch",
      (fixture) =>
        restoreGatewayQueuedOperatorRecovery({
          source: captureQueuedOperatorRecoverySource(fixture.sourceAuthority),
          liveAuthority: fixture.sourceAuthority,
          agentId: fixture.target.agentId,
          context: fixture.context,
          assertCurrent: () => {},
        }),
    ],
    [
      "scheduled plugin command",
      (fixture) =>
        restoreGatewayQueuedOperatorRecovery({
          source: { kind: "gateway", snapshot: fixture.snapshot },
          operatorSource: savedSource(fixture),
          agentId: fixture.target.agentId,
          context: fixture.context,
          assertCurrent: () => {},
        }),
    ],
    ["cron agent turn, command and script", restoreSaved],
    ["cron conversation session event", restoreSaved],
    ["native stream source", restoreSaved],
    [
      "plugin service session work",
      (fixture) =>
        restoreGatewayOperatorSource({
          snapshot: fixture.snapshot,
          agentId: fixture.target.agentId,
          context: fixture.context,
          assertCurrent: () => {},
          prepareCurrent: async () => {},
        }),
    ],
    ["restart replay of a queued chat input", restoreQueued],
    ["restart completion wake", restoreQueued],
    ["worker environment provision resume", restoreQueued],
  ])("refuses %s after the requester becomes read-only", (_kind, start) =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { fixture, demote } = await writerFixture(state.stateDir, "start-write@example.test");
      (await start(fixture)).release();
      demote();
      await expect(start(fixture)).rejects.toThrow(GatewayOperatorRecoveryAuthorizationError);
    }),
  );

  it("keeps an in-run continuation of a requester made read-only", () =>
    withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const { fixture, demote } = await writerFixture(state.stateDir, "continuation@example.test");
      demote();
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
