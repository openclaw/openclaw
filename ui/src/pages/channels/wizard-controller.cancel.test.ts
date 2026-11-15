// @vitest-environment node
// Channel wizard controller: closing a wizard releases its session before a replacement starts.
import { describe, expect, it, vi } from "vitest";
import { WizardSession } from "../../../../src/wizard/session.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  createWizardTestController as createController,
  tokenStep,
} from "./wizard-controller.test-support.ts";

describe("ChannelWizardController cancellation", () => {
  it.each(["settled", "deadline"])(
    "waits for %s cancellation before starting a replacement wizard",
    async (completion) => {
      vi.useFakeTimers();
      const cancellation = createDeferred();
      const { controller, request } = createController(async (method) => {
        if (method === "wizard.start") {
          return { sessionId: "closing", done: false, status: "running", step: tokenStep };
        }
        if (method === "wizard.cancel") {
          await cancellation.promise;
          return { status: "cancelled" };
        }
        throw new Error(`unexpected ${method}`);
      });
      try {
        await controller.start("telegram");
        const closing = controller.cancel();
        expect(controller.state).toEqual({ phase: "idle" });
        const replacement = controller.start("discord");
        expect(controller.state).toEqual({ phase: "starting", channel: "discord" });
        expect(request.mock.calls.filter(([method]) => method === "wizard.start")).toHaveLength(1);
        if (completion === "deadline") {
          await vi.advanceTimersByTimeAsync(120_000);
        } else {
          cancellation.resolve();
        }
        await Promise.all([closing, replacement]);
        expect(request.mock.calls.filter(([method]) => method === "wizard.start")).toHaveLength(2);
        expect(controller.state).toMatchObject({ phase: "step", channel: "discord" });
      } finally {
        cancellation.resolve();
        vi.useRealTimers();
      }
    },
  );

  it("releases a committed wizard's final prompt when its dialog closes", async () => {
    const session = new WizardSession(async (prompter, _signal, currentSession) => {
      currentSession.lockCancellation();
      await prompter.outro("Channels updated.");
    });
    const { controller } = createController(async (method, params) => {
      if (method === "wizard.start") {
        return { sessionId: "committed", ...(await session.next()) };
      }
      if (method === "wizard.cancel") {
        if ((params as { closeInput?: boolean }).closeInput) {
          session.close(new Error("The setup window was closed."));
        } else {
          session.cancel();
        }
        return { status: session.getStatus() };
      }
      throw new Error(`unexpected ${method}`);
    });

    try {
      await controller.start("telegram");
      expect(controller.state).toMatchObject({
        phase: "step",
        step: { message: "Channels updated." },
      });
      await controller.cancel();

      expect(controller.state).toEqual({ phase: "idle" });
      expect(session.getCurrentStep()).toBeUndefined();
      expect(session.signal.aborted).toBe(false);
      await session.whenSettled();
      expect(session.isSettled()).toBe(true);
    } finally {
      session.close(new Error("Test finished."));
      await session.whenSettled();
    }
  });
});
