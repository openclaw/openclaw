import { describe, expect, it } from "vitest";
import { WizardSession } from "../wizard/session.js";
import { createWizardSessionTracker } from "./server-wizard-sessions.js";

describe("createWizardSessionTracker", () => {
  it("reaps abandoned terminal sessions while checking for a running wizard", async () => {
    const tracker = createWizardSessionTracker();
    const terminal = new WizardSession(async () => {});
    tracker.wizardSessions.set("finished", terminal);
    await terminal.next();

    expect(tracker.findRunningWizard()).toBeNull();
    expect(tracker.wizardSessions.has("finished")).toBe(false);
  });

  it("retains and reports the running session", () => {
    const tracker = createWizardSessionTracker();
    const running = new WizardSession(async (prompter) => {
      await prompter.note("waiting");
    });
    tracker.wizardSessions.set("running", running);

    expect(tracker.findRunningWizard()).toBe("running");
    expect(tracker.wizardSessions.get("running")).toBe(running);
    running.cancel();
  });
});
