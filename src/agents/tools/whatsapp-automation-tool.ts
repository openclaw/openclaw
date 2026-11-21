import { Type } from "typebox";
import { z } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getWhatsAppAutomationTurn } from "../../cron/whatsapp-automation-turn.js";
import { manageWhatsAppAutomations } from "../../cron/whatsapp-automation.js";
import { parseSessionDeliveryRoute } from "../../routing/session-key.js";
import { gateAgentToolExecution } from "../agent-tool-availability.js";
import { stringEnum } from "../schema/string-enum.js";
import { jsonResult, type AnyAgentTool } from "./common.js";
import type { CronToolOptions } from "./cron-tool.types.js";

const schedule = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("at"), at: z.iso.datetime({ offset: true }) }),
  z.strictObject({ kind: z.literal("every"), everyMs: z.number().int().min(60_000) }),
  z.strictObject({
    kind: z.literal("cron"),
    expr: z
      .string()
      .trim()
      .regex(/^\S+(?:\s+\S+){4}$/u, "Use a five-field cron expression"),
    tz: z.string().optional(),
  }),
]);
const text = z.string().trim().min(1).max(500);
const id = z.string().min(1);
const request = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("add"),
    text,
    schedule,
    mode: z.enum(["task", "reminder"]).optional(),
  }),
  z.strictObject({ action: z.literal("list") }),
  z.strictObject({
    action: z.literal("update"),
    id,
    text: text.optional(),
    schedule: schedule.optional(),
    enabled: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal("remove"), id }),
]);

export function createWhatsAppAutomationTool(
  config: OpenClawConfig,
  runId?: string,
  sessionKey?: string,
  creator?: Pick<CronToolOptions, "creatorToolAllowlist" | "creatorToolAllowlistCaptureRef"> & {
    agentSessionId?: string;
  },
): AnyAgentTool | null {
  const route = parseSessionDeliveryRoute(sessionKey);
  if (
    config.session?.dmScope !== "per-account-channel-peer" ||
    route?.channel !== "whatsapp" ||
    !route.accountId ||
    route.peerKind !== "direct" ||
    route.threadId
  ) {
    return null;
  }
  const original = getWhatsAppAutomationTurn(runId, sessionKey);
  const automationTool: AnyAgentTool = {
    name: "whatsapp_automations",
    label: "My WhatsApp schedules",
    description:
      "Manage your private WhatsApp schedules. Use mode task to have the agent carry out text instructions when due and report its result here. Use reminder for verbatim text.",
    parameters: Type.Object(
      {
        action: stringEnum(["add", "list", "update", "remove"]),
        mode: Type.Optional(stringEnum(["task", "reminder"])),
        id: Type.Optional(Type.String()),
        text: Type.Optional(Type.String({ maxLength: 500 })),
        enabled: Type.Optional(Type.Boolean()),
        schedule: Type.Optional(
          Type.Union([
            Type.Object({ kind: Type.Literal("at"), at: Type.String() }),
            Type.Object({
              kind: Type.Literal("every"),
              everyMs: Type.Integer({ minimum: 60_000 }),
            }),
            Type.Object({
              kind: Type.Literal("cron"),
              expr: Type.String(),
              tz: Type.Optional(Type.String()),
            }),
          ]),
        ),
      },
      { additionalProperties: false },
    ),
    execute: async (_callId, input) => {
      if (!original) {
        throw new Error("Send a fresh private WhatsApp request.");
      }
      const assertCurrent = () => {
        if (getWhatsAppAutomationTurn(runId, sessionKey) !== original) {
          throw new Error("Scheduling turn has ended.");
        }
        original.assertCurrent();
      };
      assertCurrent();
      return jsonResult(
        await manageWhatsAppAutomations(
          original.cron,
          { ...original, assertCurrent },
          request.parse(input),
          creator?.agentSessionId &&
            creator.creatorToolAllowlistCaptureRef?.value?.source === "final-executable-surface"
            ? {
                sessionId: creator.agentSessionId,
                tools: (creator.creatorToolAllowlist ?? []).flatMap((tool) =>
                  typeof tool !== "string" &&
                  !tool.ownerUnverified &&
                  !tool.execOrigin &&
                  !tool.aliasName &&
                  !tool.execTarget &&
                  tool.name !== "message" &&
                  tool.name !== "whatsapp_automations"
                    ? [{ name: tool.name, ...(tool.pluginId ? { pluginId: tool.pluginId } : {}) }]
                    : [],
                ),
              }
            : undefined,
        ),
      );
    },
  };
  return original
    ? automationTool
    : gateAgentToolExecution(automationTool, "Send a fresh private WhatsApp request.");
}
