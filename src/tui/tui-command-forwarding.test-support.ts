import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import {
  createTuiCommandHandlersHarness as createHarness,
  expectSendChatFields,
} from "./tui-command-handlers-test-support.js";
import { expectUnused } from "./tui-handler-test-support.js";

export function registerTuiCommandForwardingTests() {
  it.each([
    { command: "/side check this", local: true },
    { command: "/not-a-real-command", local: true },
    { command: "/goal status", local: false },
    { command: "/model default", local: true },
    { command: "/usage cost", local: false },
    { command: "/queue:followup", local: false },
  ])("forwards $command without applying a client-side setting", async ({ command, local }) => {
    const h = createHarness({
      opts: { local },
      ...(command === "/model default"
        ? { sendChat: vi.fn().mockResolvedValue({ status: "ok" }) }
        : {}),
      ...(command === "/queue:followup"
        ? { activeChatRunId: "run-active", activityStatus: "streaming" }
        : {}),
    });
    await h.handleCommand(command);
    expectSendChatFields(h.sendChat, { sessionKey: "agent:main:main", message: command });
    expect(h.sendChat).toHaveBeenCalledOnce();
    expectUnused(h.patchSession, h.runGoalCommand, h.addSystem);
    expect(h.runUsageCostCommand).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "forwards local=%s followups and reports only confirmed queue admission",
    async (local) => {
      const queuedNotice =
        "Your message is queued for a new turn after the current turn finishes. It hasn’t changed the work already in progress.";
      for (const status of [undefined, "queued"]) {
        const send = createDeferred<{ runId: string; status?: string }>();
        const h = createHarness({ opts: { local }, sendChat: vi.fn(() => send.promise) });
        const pending = h.handleCommand("/followup next task");
        expect(h.addSystem).not.toHaveBeenCalled();
        send.resolve({ runId: "followup", status });
        await pending;
        expectSendChatFields(h.sendChat, {
          sessionKey: "agent:main:main",
          message: "/followup next task",
        });
        expect(h.sendChat).toHaveBeenCalledOnce();
        expectUnused(h.patchSession, h.runGoalCommand);
        expect(h.runUsageCostCommand).not.toHaveBeenCalled();
        expect(h.addSystem.mock.calls).toEqual(
          local && status === "queued" ? [[queuedNotice]] : [],
        );
      }
    },
  );
}
