/* @vitest-environment jsdom */
import { expect, it } from "vitest";
import { waitForFast } from "../../test-helpers/wait-for.ts";
import {
  activated,
  callsFor,
  candidate,
  clickCandidate,
  createFirstRunContext,
  modalButton,
  mockRequests,
  mountDetection,
  pendingReceipt,
  runningStep,
  useFirstRunFixtures,
} from "./model-setup-first-run.test-support.ts";
import { MODEL_SETUP_AUTH_START_TIMEOUT_MS } from "./state.ts";

useFirstRunFixtures("test-device-key");

it.each(["accept", "decline", "cancel"] as const)(
  "requires an explicit answer before activation (%s)",
  async (decision) => {
    const { context, client, request } = createFirstRunContext();
    const answers: unknown[] = [];
    let activeSession: string | undefined;
    mockRequests(request, {
      "openclaw.setup.activate.start": (params) => {
        activeSession = (params as { sessionId: string }).sessionId;
        return { sessionId: activeSession, done: false, status: "running" };
      },
      "wizard.next": (params) => {
        const next = params as {
          sessionId: string;
          answer?: { stepId: string; value?: unknown };
        };
        expect(next.sessionId).toBe(activeSession);
        if (!next.answer) {
          return runningStep({
            id: "review",
            type: "note",
            title: "Review model setup",
            message: "This changes the selected model route.",
          });
        }
        answers.push(next.answer);
        if (next.answer.stepId === "review") {
          return runningStep({
            id: "consent",
            type: "confirm",
            title: "Confirm model setup",
            message: "Apply the reviewed changes?",
            initialValue: false,
          });
        }
        return next.answer.value === true
          ? activated("provider/selected")
          : { done: true, status: "cancelled", error: "Model setup was declined." };
      },
      "wizard.cancel": () => ({ status: "cancelled" }),
    });
    const { page } = await mountDetection(context, client, {
      candidates: [
        candidate("codex-cli", "provider/selected", true),
        candidate("openai-api-key", "provider/other", true),
      ],
    });
    expect(request).not.toHaveBeenCalled();
    await clickCandidate(page, "openai-api-key");
    await waitForFast(() => expect(page.textContent).toContain("Review model setup"));
    expect(context.navigate).not.toHaveBeenCalled();
    modalButton(page, "Continue")!.click();
    await waitForFast(() => expect(page.textContent).toContain("Apply the reviewed changes?"));
    expect(answers).toEqual([{ stepId: "review", value: undefined }]);
    expect(context.navigate).not.toHaveBeenCalled();
    modalButton(page, { accept: "Yes", decline: "No", cancel: "Cancel" }[decision])!.click();
    if (decision === "accept") {
      await waitForFast(() =>
        expect(context.navigate).toHaveBeenCalledWith("custodian", { search: "?onboarding=1" }),
      );
      expect(answers.at(-1)).toEqual({ stepId: "consent", value: true });
    } else {
      await waitForFast(() => expect(pendingReceipt()).toBeNull());
      expect(context.navigate).not.toHaveBeenCalled();
      if (decision === "decline") {
        expect(answers.at(-1)).toEqual({ stepId: "consent", value: false });
      } else {
        expect(request).toHaveBeenCalledWith(
          "wizard.cancel",
          { sessionId: activeSession },
          { timeoutMs: MODEL_SETUP_AUTH_START_TIMEOUT_MS },
        );
      }
    }
    expect(callsFor(request, "openclaw.setup.activate.start")).toHaveLength(1);
    expect(callsFor(request, "openclaw.setup.activate")).toHaveLength(0);
  },
);
