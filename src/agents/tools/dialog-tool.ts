import { Type } from "@sinclair/typebox";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import type { AnyAgentTool } from "./common.js";
import { callGateway } from "../../gateway/call.js";
import { optionalStringEnum } from "../schema/typebox.js";
import { jsonResult } from "./common.js";

const DialogToolSchema = Type.Object({
  questions: Type.Array(
    Type.Object({
      id: Type.String(),
      type: optionalStringEnum(["text", "select", "confirm", "multiselect"] as const),
      prompt: Type.String(),
      options: Type.Optional(
        Type.Array(
          Type.Object({
            value: Type.String(),
            label: Type.String(),
          }),
        ),
      ),
    }),
  ),
  intro: Type.Optional(Type.String()),
  outro: Type.Optional(Type.String()),
  expiresInMinutes: Type.Optional(Type.Number()),
});

export function createDialogTool(opts?: {
  agentSessionKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
}): AnyAgentTool {
  return {
    label: "Dialog",
    name: "dialog",
    description:
      "Start a deterministic multi-step dialog that sends scripted questions to the user one at a time and collects their answers. " +
      "Questions are sent as channel messages; user responses are intercepted before they reach the LLM. " +
      "Returns immediately after starting the dialog. Results are delivered to the session when all questions are answered.",
    parameters: DialogToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const questions = params.questions;
      if (!Array.isArray(questions) || questions.length === 0) {
        return jsonResult({ error: "questions required" });
      }

      const steps = questions.map((q: Record<string, unknown>, idx: number) => ({
        id: typeof q.id === "string" && q.id.trim() ? q.id.trim() : `step_${idx + 1}`,
        type: typeof q.type === "string" ? q.type : "text",
        prompt: typeof q.prompt === "string" ? q.prompt : "",
        options: Array.isArray(q.options) ? q.options : undefined,
      }));

      const intro = typeof params.intro === "string" ? params.intro.trim() : undefined;
      const outro = typeof params.outro === "string" ? params.outro.trim() : undefined;
      const expiresInMinutes =
        typeof params.expiresInMinutes === "number" &&
        Number.isFinite(params.expiresInMinutes) &&
        params.expiresInMinutes > 0
          ? params.expiresInMinutes
          : 60;

      const sessionKey = opts?.agentSessionKey;
      if (!sessionKey) {
        return jsonResult({ error: "no active session" });
      }

      let payload: Record<string, unknown>;
      try {
        payload = await callGateway({
          method: "dialog.start",
          params: {
            sessionKey,
            steps,
            expiresInMinutes,
            channel: opts?.agentChannel,
            to: opts?.agentTo,
            accountId: opts?.agentAccountId,
            threadId: opts?.agentThreadId !== undefined ? String(opts.agentThreadId) : undefined,
            intro: intro || undefined,
            outro: outro || undefined,
          },
        });
      } catch (err) {
        return jsonResult({
          error: err instanceof Error ? err.message : "failed to start dialog",
        });
      }

      const dialogId = payload.dialogId as string;

      // Set the activeDialogId on the session
      try {
        await callGateway({
          method: "sessions.patch",
          params: {
            key: sessionKey,
            activeDialogId: dialogId,
          },
        });
      } catch {
        // Best-effort; the dialog was already started
      }

      // Send intro message if provided
      if (intro) {
        try {
          await callGateway({
            method: "send",
            params: {
              text: intro,
              channel: opts?.agentChannel,
              to: opts?.agentTo,
              accountId: opts?.agentAccountId,
              threadId: opts?.agentThreadId,
              sessionKey,
            },
          });
        } catch {
          // Best-effort
        }
      }

      // Send first question
      const currentStep = payload.currentStep as {
        id: string;
        prompt: string;
      } | null;
      if (currentStep) {
        try {
          await callGateway({
            method: "send",
            params: {
              text: currentStep.prompt,
              channel: opts?.agentChannel,
              to: opts?.agentTo,
              accountId: opts?.agentAccountId,
              threadId: opts?.agentThreadId,
              sessionKey,
            },
          });
        } catch {
          // Best-effort
        }
      }

      return jsonResult({
        status: "started",
        dialogId,
        totalSteps: payload.totalSteps,
        message:
          "Dialog started. Questions will be sent one at a time. User responses are intercepted and recorded. Results will be delivered to your session when complete.",
      });
    },
  };
}
