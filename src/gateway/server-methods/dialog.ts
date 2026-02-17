import type { DialogStep } from "../../dialog/types.js";
import {
  ErrorCodes,
  errorShape,
  validateDialogStartParams,
  validateDialogAnswerParams,
  validateDialogCancelParams,
  validateDialogStatusParams,
} from "../protocol/index.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function formatStepPrompt(step: DialogStep): string {
  let text = step.prompt;
  if (step.options && step.options.length > 0) {
    const optionLines = step.options.map((opt, idx) => `${idx + 1}. ${opt.label}`);
    text += "\n" + optionLines.join("\n");
  }
  if (step.type === "confirm") {
    text += "\n(yes/no)";
  }
  return text;
}

export const dialogHandlers: GatewayRequestHandlers = {
  "dialog.start": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateDialogStartParams, "dialog.start", respond)) {
      return;
    }

    const steps: DialogStep[] = params.steps.map((s) => ({
      id: s.id,
      type: s.type ?? "text",
      prompt: s.prompt,
      options: s.options,
    }));

    let session;
    try {
      session = context.dialogManager.create({
        sessionKey: params.sessionKey,
        steps,
        expiresInMs: params.expiresInMinutes ? params.expiresInMinutes * 60 * 1000 : undefined,
        channel: params.channel,
        to: params.to,
        accountId: params.accountId,
        threadId: params.threadId,
        intro: params.intro,
        outro: params.outro,
      });
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      return;
    }

    const firstStep = session.currentStep();
    respond(
      true,
      {
        dialogId: session.dialogId,
        status: session.getStatus(),
        currentStep: firstStep ? { id: firstStep.id, prompt: formatStepPrompt(firstStep) } : null,
        totalSteps: steps.length,
      },
      undefined,
    );
  },

  "dialog.answer": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateDialogAnswerParams, "dialog.answer", respond)) {
      return;
    }

    const session = context.dialogManager.get(params.dialogId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "dialog not found"));
      return;
    }

    if (session.getStatus() !== "running") {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "dialog not running"));
      return;
    }

    let result;
    try {
      result = session.answer(params.value);
    } catch (err) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
      return;
    }

    const state = session.getState();
    const answers = result.done ? session.getAnswerMap() : undefined;
    const outro = result.done ? state.outro : undefined;

    if (result.done) {
      context.dialogManager.purge(params.dialogId);
    }

    respond(
      true,
      {
        dialogId: state.dialogId,
        done: result.done,
        status: state.status,
        currentStep: result.next
          ? { id: result.next.id, prompt: formatStepPrompt(result.next) }
          : null,
        answers,
        outro,
      },
      undefined,
    );
  },

  "dialog.cancel": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateDialogCancelParams, "dialog.cancel", respond)) {
      return;
    }

    const ok = context.dialogManager.cancel(params.dialogId);
    if (!ok) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "dialog not found"));
      return;
    }
    respond(true, { status: "cancelled" }, undefined);
  },

  "dialog.status": ({ params, respond, context }) => {
    if (!assertValidParams(params, validateDialogStatusParams, "dialog.status", respond)) {
      return;
    }

    const session = context.dialogManager.get(params.dialogId);
    if (!session) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "dialog not found"));
      return;
    }

    const state = session.getState();
    respond(
      true,
      {
        dialogId: state.dialogId,
        status: state.status,
        currentStepIndex: state.currentStepIndex,
        totalSteps: state.steps.length,
        answeredCount: state.answers.length,
        answers: state.status === "done" ? session.getAnswerMap() : undefined,
      },
      undefined,
    );
  },
};
