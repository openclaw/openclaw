// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createContext } from "../pages/system-history/test-support.ts";
import { takeHomeHelpDraft } from "./home-help.ts";
import type { UpdateFailureTriage } from "./update-overlay-helpers.ts";
import { presentUpdateFailureTriage } from "./update-triage.runtime.ts";

const failure: UpdateFailureTriage = {
  id: "attempt",
  outcome: "failed",
  banner: { tone: "danger", text: "Build failed" },
  attempt: {
    timestampMs: 1000,
    status: "error",
    reason: "build-failed",
    installKind: "git",
    beforeVersion: "1",
    beforeSha: "1".repeat(40),
    afterVersion: "1",
    afterSha: "2".repeat(40),
    failure: { step: "build", detail: "Disk is full" },
  },
};
it.each(["failed", "unknown"] as const)(
  "keeps %s update facts in an unsent optional Home question",
  (outcome) => {
    const request = vi.fn();
    const { context } = createContext(request, ["chat.send"]);
    const admission = { isCurrent: () => true, admit: vi.fn(() => true) };
    presentUpdateFailureTriage(
      context,
      { ...failure, outcome, ...(outcome === "unknown" ? { attempt: null } : {}) },
      admission,
    );
    const draft = takeHomeHelpDraft(context, { agentId: "main", sessionKey: "global" });
    expect(draft).toContain(outcome === "unknown" ? "unknown" : "Disk is full");
    expect(draft).toContain("Do not retry the update");
    expect(request).not.toHaveBeenCalled();
    expect(admission.admit).toHaveBeenCalledOnce();
  },
);
it("opens Updates without inference and ignores retired admissions", () => {
  const { context } = createContext(vi.fn(), []);
  presentUpdateFailureTriage(context, failure, { isCurrent: () => false, admit: () => true });
  expect(context.navigate).not.toHaveBeenCalled();
  presentUpdateFailureTriage(context, failure, { isCurrent: () => true, admit: () => true });
  expect(context.navigate).toHaveBeenCalledExactlyOnceWith("updates");
});
