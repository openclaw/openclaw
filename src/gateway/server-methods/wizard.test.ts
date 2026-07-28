// Wizard server-method tests cover stable lifecycle errors for process-local sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WizardSession } from "../../wizard/session.js";
import type { GatewayRequestHandlerOptions } from "./types.js";
import { wizardHandlers } from "./wizard.js";

describe("wizard session lookup", () => {
  it.each([
    { method: "wizard.next", params: { sessionId: "expired" } },
    { method: "wizard.cancel", params: { sessionId: "expired" } },
    { method: "wizard.status", params: { sessionId: "expired" } },
  ] as const)("returns structured details from $method", async ({ method, params }) => {
    const respond = vi.fn();
    const handler = expectDefined(
      wizardHandlers[method],
      `wizardHandlers[${method}] test invariant`,
    );

    await handler({
      req: { type: "req", id: "wizard-missing", method, params },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond,
      context: { wizardSessions: new Map() } as never,
    } as GatewayRequestHandlerOptions);

    expect(respond).toHaveBeenCalledOnce();
    expect(respond).toHaveBeenCalledWith(false, undefined, {
      code: "INVALID_REQUEST",
      message: "wizard not found",
      details: { code: "WIZARD_NOT_FOUND" },
    });
  });
});

describe("channel wizard lifecycle", () => {
  it("rejects a persistent effect after cancellation wins the lock race", async () => {
    let beforePersistentEffect: (() => Promise<void>) | undefined;
    const wizardSessions = new Map<string, WizardSession>();
    const respond = vi.fn();
    const handler = expectDefined(
      wizardHandlers["wizard.start"],
      "wizardHandlers[wizard.start] test invariant",
    );
    const context = {
      wizardSessions,
      findRunningWizard: () => null,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
      channelWizardRunner: async (
        options: { beforePersistentEffect?: () => Promise<void> },
        _runtime: unknown,
        prompter: { note: (message: string) => Promise<void> },
      ) => {
        beforePersistentEffect = options.beforePersistentEffect;
        await prompter.note("Ready");
      },
    };

    await handler({
      req: {
        type: "req",
        id: "wizard-lock-race",
        method: "wizard.start",
        params: { flow: "channels", channel: "signal" },
      },
      params: { flow: "channels", channel: "signal" },
      client: null,
      isWebchatConnect: () => false,
      respond,
      context,
    } as never);

    const session = expectDefined(
      wizardSessions.values().next().value,
      "running channel wizard session",
    );
    expect(session.cancel()).toBe(true);
    await expect(expectDefined(beforePersistentEffect, "persistent effect hook")()).rejects.toThrow(
      "cancelled before its persistent change started",
    );
  });

  it("resumes a cancellation-locked channel wizard and expires it when abandoned", async () => {
    vi.useFakeTimers();
    try {
      const ownerClient = {
        connId: "conn-owner",
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      };
      const otherClient = {
        connId: "conn-other",
        connect: { client: { id: "openclaw-control-ui", mode: "webchat" } },
      };
      const wizardSessions = new Map<string, WizardSession>();
      const findRunningWizard = () =>
        [...wizardSessions].find(([, session]) => session.isRunning())?.[0] ?? null;
      const context = {
        wizardSessions,
        findRunningWizard,
        purgeWizardSession: (id: string) => wizardSessions.delete(id),
        channelWizardRunner: async (
          _options: unknown,
          _runtime: unknown,
          prompter: { note: (message: string) => Promise<void> },
        ) => {
          await prompter.note("Installing Signal");
        },
      };
      const start = expectDefined(
        wizardHandlers["wizard.start"],
        "wizardHandlers[wizard.start] test invariant",
      );
      const cancel = expectDefined(
        wizardHandlers["wizard.cancel"],
        "wizardHandlers[wizard.cancel] test invariant",
      );
      const firstRespond = vi.fn();

      await start({
        req: {
          type: "req",
          id: "wizard-first-owner",
          method: "wizard.start",
          params: { flow: "channels", channel: "signal" },
        },
        params: { flow: "channels", channel: "signal" },
        client: ownerClient,
        isWebchatConnect: () => false,
        respond: firstRespond,
        context,
      } as never);

      const firstResult = firstRespond.mock.calls[0]?.[1] as
        | { sessionId?: string; step?: { id?: string } }
        | undefined;
      const sessionId = expectDefined(firstResult?.sessionId, "channel wizard session id");
      const stepId = expectDefined(firstResult?.step?.id, "channel wizard step id");
      const session = expectDefined(wizardSessions.get(sessionId), "channel wizard session");
      expect(session.lockCancellation()).toBe(true);

      const cancelRespond = vi.fn();
      await cancel({
        req: {
          type: "req",
          id: "wizard-refused-cancel",
          method: "wizard.cancel",
          params: { sessionId },
        },
        params: { sessionId },
        client: null,
        isWebchatConnect: () => false,
        respond: cancelRespond,
        context,
      } as never);
      expect(cancelRespond).toHaveBeenCalledWith(
        true,
        { status: "running", error: undefined },
        undefined,
      );

      for (const attempt of [
        { id: "wizard-wrong-owner", client: otherClient, channel: "signal" },
        { id: "wizard-wrong-channel", client: ownerClient, channel: "telegram" },
      ]) {
        const deniedRespond = vi.fn();
        await start({
          req: {
            type: "req",
            id: attempt.id,
            method: "wizard.start",
            params: { flow: "channels", channel: attempt.channel },
          },
          params: { flow: "channels", channel: attempt.channel },
          client: attempt.client,
          isWebchatConnect: () => false,
          respond: deniedRespond,
          context,
        } as never);
        expect(deniedRespond).toHaveBeenCalledWith(
          false,
          undefined,
          expect.objectContaining({ code: "UNAVAILABLE", message: "wizard already running" }),
        );
      }

      const resumedRespond = vi.fn();
      await start({
        req: {
          type: "req",
          id: "wizard-resumed-owner",
          method: "wizard.start",
          params: { flow: "channels", channel: "signal" },
        },
        params: { flow: "channels", channel: "signal" },
        client: ownerClient,
        isWebchatConnect: () => false,
        respond: resumedRespond,
        context,
      } as never);
      expect(resumedRespond).toHaveBeenCalledWith(
        true,
        expect.objectContaining({
          sessionId,
          done: false,
          status: "running",
          step: expect.objectContaining({ id: stepId }),
        }),
        undefined,
      );

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
      expect(session.getStatus()).toBe("cancelled");
      expect(findRunningWizard()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
