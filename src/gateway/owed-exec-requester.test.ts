import "../test-utils/prepare-compiled-subprocesses.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_OWNER_PROFILE_ID } from "../../packages/gateway-protocol/src/schema/users.js";
import { prepareAdoptedDurableProcessNotification } from "../agents/bash-process-durable-notify.js";
import { addSession } from "../agents/bash-process-registry.js";
import { createProcessSessionFixture } from "../agents/bash-process-registry.test-helpers.js";
import * as execNotify from "../agents/bash-tools.exec-notify.js";
import * as sessionEventBatch from "../auto-reply/reply/session-event-batch.js";
import { readSessionEventTargetOperatorAuthority } from "../auto-reply/reply/session-event-target.js";
import { setRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import { patchSessionEntryCore } from "../config/sessions/session-accessor.js";
import { listSessionPendingInputs } from "../config/sessions/session-pending-input-history.js";
import { withPluginRuntimeGatewayContextResolver } from "../plugins/runtime/gateway-request-scope.js";
import { chatRef } from "../sessions/chat-ref.js";
import { owe } from "../sessions/owed.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { decideChannelOwnerPrincipal } from "./operator-admission.js";
import { captureChannelOperatorRunAuthority } from "./operator-run-authority.js";
import type { QueuedOperatorRecoverySource } from "./operator-run-recovery-source.codec.js";
import { captureQueuedOperatorRecoverySource } from "./operator-run-recovery-source.js";
import {
  pairedOperator,
  recoveryFixture,
  type RecoveryFixture,
} from "./operator-run-recovery.test-support.js";
import { continueSessionQueuedInputs } from "./queued-chat-inputs.js";

const owner = { channelId: "discord", accountId: "default", senderId: "111" };
const ownerConfig = { commands: { ownerAllowFrom: ["discord:111"] } };

const woken = (
  target: Parameters<typeof readSessionEventTargetOperatorAuthority>[0] | undefined,
) => {
  const authority = target && readSessionEventTargetOperatorAuthority(target);
  return authority && { profileId: authority.profileId, owner: authority.grant.owner };
};

// A durable or lost ordinary process restored from its record exits after a Gateway restart.
async function exitAfterRestart(
  exec: RecoveryFixture,
  operatorSource?: QueuedOperatorRecoverySource,
) {
  const process = createProcessSessionFixture({ id: randomUUID(), backgrounded: true });
  Object.assign(process, {
    agentId: exec.target.agentId,
    sessionKey: exec.target.sessionKey,
    notifyOnExit: true,
    notifyOnExitEmptySuccess: true,
    exited: true,
    exitCode: 0,
    operatorSource,
  });
  await prepareAdoptedDurableProcessNotification(process);
  addSession(process);
  using enqueue = vi
    .spyOn(sessionEventBatch, "enqueueBatchedSessionEventForHost")
    .mockReturnValue({ cancel: () => false, settled: new Promise(() => {}) } as never);
  await withPluginRuntimeGatewayContextResolver(exec.context.resolveGatewayContext, () =>
    execNotify.maybeNotifyOnExit(process, "completed", false),
  );
  return enqueue.mock.calls.map(([, options]) => woken(options.expectedTarget));
}

describe("restored process exit after a restart", () => {
  it.each([
    // (a) A member's job in the owner's session wakes as the member, not the owner.
    {
      requester: "member",
      scopes: ["operator.sessions.write"],
      sessionOwner: "gateway",
      owner: false,
    },
    // (b) An admin's job in another person's session wakes as the admin.
    { requester: "admin", scopes: ["operator.admin"], sessionOwner: "person", owner: true },
  ])("wakes a $requester's job as that requester", (cell) =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      setRuntimeConfigSnapshot({});
      const requester = ensureProfileForEmail("exec-requester@example.test");
      const exec = await recoveryFixture(stateDir, requester.id, {
        device: pairedOperator(),
        scopes: cell.scopes,
      });
      const sessionOwner =
        cell.sessionOwner === "gateway"
          ? GATEWAY_OWNER_PROFILE_ID
          : ensureProfileForEmail("session-owner@example.test").id;
      await patchSessionEntryCore(
        exec.target,
        () => ({ createdActor: { type: "human", source: "profile", id: sessionOwner } }),
        { skipMaintenance: true },
      );
      const source = captureQueuedOperatorRecoverySource(exec.sourceAuthority);
      expect(await exitAfterRestart(exec, source)).toEqual([
        { profileId: requester.id, owner: cell.owner },
      ]);
      // The stored result carries the source, so a second restart follows the same requester.
      const [row] = (await listSessionPendingInputs(exec.target)).items;
      expect(row?.message).toMatchObject({ originFacts: { operatorSource: source } });
    }),
  );

  it("keeps the result visible with its cause when the requester lost session write", () =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      setRuntimeConfigSnapshot({});
      const requester = ensureProfileForEmail("exec-requester@example.test");
      const exec = await recoveryFixture(stateDir, requester.id, {
        device: pairedOperator(),
        scopes: ["operator.read"],
      });
      const source = captureQueuedOperatorRecoverySource(exec.sourceAuthority);
      expect(await exitAfterRestart(exec, source)).toEqual([]);
      const [row] = (await listSessionPendingInputs(exec.target)).items;
      expect(row && { state: row.state, endCause: row.endCause }).toEqual({
        state: "cancelled",
        endCause: "revoked",
      });
    }));
});

describe("configured channel owner's saved work after a restart", () => {
  async function ownerFixture(stateDir: string) {
    setRuntimeConfigSnapshot(ownerConfig);
    const member = ensureProfileForEmail("guild-member@example.test");
    const exec = await recoveryFixture(stateDir, member.id, { device: pairedOperator() });
    exec.setConfig(ownerConfig);
    const principal = decideChannelOwnerPrincipal(ownerConfig, owner);
    const authority =
      principal &&
      captureChannelOperatorRunAuthority({ ...principal, getRuntimeConfig: () => ownerConfig });
    const source = captureQueuedOperatorRecoverySource(authority);
    expect(source).toEqual({ kind: "channel-owner", sender: owner });
    const oweExec = (id: string, operatorSource?: QueuedOperatorRecoverySource) =>
      owe({
        id,
        to: chatRef(exec.target),
        kind: "exec",
        text: `Exec completed (${id}, code 0)`,
        ...(operatorSource ? { originFacts: { operatorSource } } : {}),
      });
    const replay = async () => {
      using wake = vi.spyOn(execNotify, "wakeOwedExec").mockResolvedValue();
      await continueSessionQueuedInputs(exec.context, exec.target, {
        signal: new AbortController().signal,
        assertCurrent: () => {},
      });
      return wake.mock.calls.map(([owed, options]) => [owed.id, woken(options?.expectedTarget)]);
    };
    return { exec, source, oweExec, replay };
  }

  // (c) The owner's result keeps the owner grant; (e) a member's result in the same guild
  // session never borrows it: nothing is recorded on the session.
  it("wakes the owner's result as the owner and a member's result without the owner grant", () =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const { exec, source, oweExec, replay } = await ownerFixture(stateDir);
      await oweExec("exec:owner-job", source);
      await oweExec("exec:member-job");
      expect(await replay()).toEqual([
        ["exec:owner-job", { profileId: GATEWAY_OWNER_PROFILE_ID, owner: true }],
        ["exec:member-job", undefined],
      ]);
      const restarted = await exitAfterRestart(exec, source);
      expect(restarted).toEqual([{ profileId: GATEWAY_OWNER_PROFILE_ID, owner: true }]);
    }));

  // (d) A sender removed from commands.ownerAllowFrom is refused, and the result shows why.
  it("refuses a removed owner's result visibly", () =>
    withOpenClawTestState({ scenario: "minimal" }, async ({ stateDir }) => {
      const { exec, source, oweExec, replay } = await ownerFixture(stateDir);
      await oweExec("exec:owner-job", source);
      exec.setConfig({ commands: { ownerAllowFrom: ["discord:999"] } });
      expect(await replay()).toEqual([]);
      const [row] = (await listSessionPendingInputs(exec.target)).items;
      expect(row && { state: row.state, endCause: row.endCause }).toEqual({
        state: "cancelled",
        endCause: "revoked",
      });
    }));
});
