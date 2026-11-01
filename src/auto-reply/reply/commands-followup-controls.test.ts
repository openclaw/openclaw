import { expect, it, vi } from "vitest";
import { withAdminIngress } from "../../channels/message-access/operator-authority.test-support.js";
import {
  reserveSessionControllerSource,
  retireSessionControllerInput,
} from "../../sessions/session-controller.mailbox.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import { captureSessionTarget } from "../../sessions/session-controller.target.js";
import { getCanonicalUserPreferences } from "../../state/user-preferences.js";
import { getCommandOwnerAuthority } from "../command-owner-authority.js";
import { resolveTextCommand } from "../commands-registry.js";
import { handleFollowupModeCommand, handleInterruptCommand } from "./commands-followup-controls.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

it("discovers personal defaults and original queued-input interrupt controls", () => {
  expect(resolveTextCommand("/followupmode interrupt")?.command.key).toBe("followupmode");
  expect(resolveTextCommand("/interrupt queued-input-id")?.command.key).toBe("interrupt");
});

it("writes the linked submitting person's preference through the canonical profile owner", async () => {
  await withAdminIngress(async ({ cfg, admins, context }) => {
    const ctx = await context(admins[0]!.identity.senderId);
    const authority = getCommandOwnerAuthority(ctx)?.operatorAuthority;
    expect(authority).toBeDefined();
    for (const mode of ["queue", "steer", "interrupt", "default"]) {
      const params = buildCommandTestParams("/followupmode " + mode, cfg, ctx);
      params.opts = { operatorAuthority: authority };
      expect(await handleFollowupModeCommand(params, true)).toMatchObject({
        shouldContinue: false,
      });
      const actual = await getCanonicalUserPreferences(admins[0]!.profile.id, [
        "chat.followUpMode",
      ]);
      expect(actual?.entries["chat.followUpMode"]).toBe(mode === "default" ? undefined : mode);
      expect(
        (await getCanonicalUserPreferences(admins[1]!.profile.id, ["chat.followUpMode"]))?.entries[
          "chat.followUpMode"
        ],
      ).toBeUndefined();
    }
  });
});

it("lists and promotes the original retained input, preserving siblings and rejecting stale custody", async () => {
  const cfg = { commands: { text: true } };
  const params = buildCommandTestParams("/interrupt list", cfg);
  params.storePath = "/workspace/interrupt-command-store/sessions.json";
  params.sessionEntry = { sessionId: "interrupt-command-session", updatedAt: 1 };
  const target = captureSessionTarget({
    storeScope: params.storePath,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    incarnation: params.sessionEntry.sessionId,
  });
  const active = createReplyOperation({
    sessionKey: params.sessionKey,
    sessionId: params.sessionEntry.sessionId,
    resetTriggered: false,
    target,
  });
  const cancel = vi.fn();
  active.setPhase("running");
  active.attachBackend({ kind: "embedded", cancel });
  const inputs = ["older", "selected", "later"].map((protocolRunId) => {
    const input = reserveSessionControllerSource(params.sessionKey, {
      target,
      protocolRunId,
      policy: { mode: "followup" },
    });
    input.custody.rpcAccepted = true;
    return input;
  });
  try {
    const list = await handleInterruptCommand(params, true);
    expect(list?.reply?.text).toContain("selected");
    params.command.commandBodyNormalized = "/interrupt selected";
    let current = true;
    params.opts = {
      isCommandTargetCurrent: () => current,
      turnAdoptionLifecycle: {
        onAdopted: async () => {
          current = false;
        },
      },
    };
    await expect(handleInterruptCommand(params, true)).rejects.toThrow("session changed");
    expect(inputs[1]!.policy.mode).toBe("followup");
    expect(cancel).not.toHaveBeenCalled();
    params.opts = undefined;
    expect((await handleInterruptCommand(params, true))?.reply?.text).toContain(
      "Interrupt & send requested",
    );
    expect(active.abortSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledOnce();
    expect(inputs[1]!.mailbox.priority).toBe(inputs[1]);
    expect(inputs.map((input) => input.abortSignal.aborted)).toEqual([false, false, false]);
    inputs[1]!.phase = "injecting";
    expect((await handleInterruptCommand(params, true))?.reply?.text).toContain(
      "no longer safely queued",
    );
    expect(cancel).toHaveBeenCalledOnce();
    inputs[1]!.phase = "waiting";
    params.sessionEntry.sessionId = "replacement-session";
    expect((await handleInterruptCommand(params, true))?.reply?.text).toContain(
      "no longer safely queued",
    );
  } finally {
    active.complete();
    for (const input of inputs) {
      retireSessionControllerInput(input);
    }
    await Promise.all(inputs.map((input) => input.settlement.promise));
  }
});

it("does not mutate anything for an unauthorized or revoked command", async () => {
  const params = buildCommandTestParams("/interrupt list", { commands: { text: true } });
  params.command.isAuthorizedSender = false;
  expect(await handleInterruptCommand(params, true)).toEqual({ shouldContinue: false });
  expect(await handleInterruptCommand(params, false)).toBeNull();
  params.command.isAuthorizedSender = true;
  params.opts = { isCommandTargetCurrent: () => false };
  expect((await handleInterruptCommand(params, true))?.reply?.text).toContain("session changed");
});
