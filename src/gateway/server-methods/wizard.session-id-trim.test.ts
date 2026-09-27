import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import {
  getActiveGatewayRootWorkCount,
  resetGatewayWorkAdmission,
  runWithGatewayIndependentRootWorkAdmission,
} from "../../process/gateway-work-admission.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { WizardSession } from "../../wizard/session.js";
import { bindWizardLoginOwner, createWizardSessionTracker } from "../server-wizard-sessions.js";
import type { GatewayClient } from "./client-types.js";
import { whenAdmittedWizardSessionSettled } from "./setup-admission.js";
import { wizardHandlers } from "./wizard.js";

afterEach(() => {
  resetGatewayWorkAdmission();
});

describe("wizard.cancel padded sessionId", () => {
  it("cancels a live wizard when sessionId has surrounding whitespace", async () => {
    const runnerSettled = createDeferred();
    const tracker = createWizardSessionTracker();
    const context = {
      ...tracker,
      wizardRunner: async (_opts: unknown, _runtime: RuntimeEnv, prompter: WizardPrompter) => {
        prompter.progress("working");
        await runnerSettled.promise;
      },
    };

    let sessionId = "";
    await runWithGatewayIndependentRootWorkAdmission(async () => {
      const respond = vi.fn();
      await wizardHandlers["wizard.start"]!({
        params: { mode: "local" },
        respond,
        context,
      } as never);
      sessionId = String(respond.mock.calls[0]?.[1]?.sessionId ?? "");
    });
    expect(sessionId).not.toBe("");
    expect(tracker.wizardSessions.has(sessionId)).toBe(true);
    expect(getActiveGatewayRootWorkCount()).toBe(1);

    const cancelRespond = vi.fn();
    await wizardHandlers["wizard.cancel"]!({
      params: { sessionId: ` ${sessionId} ` },
      respond: cancelRespond,
      context,
    } as never);

    expect(cancelRespond.mock.calls[0]?.[0]).toBe(true);
    expect(cancelRespond.mock.calls[0]?.[1]).toMatchObject({ status: "cancelled" });

    runnerSettled.resolve();
    const session = tracker.wizardSessions.get(sessionId);
    if (session) {
      await whenAdmittedWizardSessionSettled(session).catch(() => undefined);
    }
  });

  it("prefers an exact caller-supplied padded session over the trimmed spelling", async () => {
    const paddedHold = createDeferred();
    const trimmedHold = createDeferred();
    const tracker = createWizardSessionTracker();
    const padded = new WizardSession(async () => {
      await paddedHold.promise;
    });
    const trimmed = new WizardSession(async () => {
      await trimmedHold.promise;
    });
    tracker.wizardSessions.set(" login ", padded);
    tracker.wizardSessions.set("login", trimmed);

    const respond = vi.fn();
    await wizardHandlers["wizard.cancel"]!({
      params: { sessionId: " login " },
      respond,
      context: tracker,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(respond.mock.calls[0]?.[1]).toMatchObject({ status: "cancelled" });
    expect(padded.getStatus()).toBe("cancelled");
    expect(trimmed.getStatus()).toBe("running");
    expect(tracker.wizardSessions.get("login")).toBe(trimmed);

    paddedHold.resolve();
    trimmedHold.resolve();
    await whenAdmittedWizardSessionSettled(padded).catch(() => undefined);
    await whenAdmittedWizardSessionSettled(trimmed).catch(() => undefined);
  });

  it("does not fall back to the trimmed wizard when the exact padded session is unauthorized", async () => {
    const paddedHold = createDeferred();
    const trimmedHold = createDeferred();
    const tracker = createWizardSessionTracker();
    const padded = new WizardSession(async () => {
      await paddedHold.promise;
    });
    const trimmed = new WizardSession(async () => {
      await trimmedHold.promise;
    });
    const owner = { connId: "wizard-owner", invalidated: false } as GatewayClient;
    const other = { connId: "wizard-other", invalidated: false } as GatewayClient;
    bindWizardLoginOwner(padded, owner);
    tracker.wizardSessions.set(" login ", padded);
    tracker.wizardSessions.set("login", trimmed);

    const respond = vi.fn();
    await wizardHandlers["wizard.status"]!({
      params: { sessionId: " login " },
      respond,
      context: tracker,
      client: other,
    } as never);

    expect(respond.mock.calls[0]?.[0]).toBe(false);
    expect(respond.mock.calls[0]?.[2]).toMatchObject({
      details: { code: "WIZARD_NOT_FOUND" },
    });
    expect(tracker.wizardSessions.get(" login ")).toBe(padded);
    expect(tracker.wizardSessions.get("login")).toBe(trimmed);
    expect(trimmed.getStatus()).toBe("running");

    paddedHold.resolve();
    trimmedHold.resolve();
    await whenAdmittedWizardSessionSettled(padded).catch(() => undefined);
    await whenAdmittedWizardSessionSettled(trimmed).catch(() => undefined);
  });
});
