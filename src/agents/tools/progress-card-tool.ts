import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import {
  PROGRESS_CARD_MAX_STEPS,
  ProgressCardStepSchema,
  type ProgressCardPutResult,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  normalizeProgressCardInput,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";
import { recordProgressCardToolOutcome } from "./progress-card-tool-outcome.js";

const ProgressCardToolSchema = Type.Object(
  {
    markdown: Type.Optional(Type.String()),
    plan: Type.Optional(Type.Array(ProgressCardStepSchema, { maxItems: PROGRESS_CARD_MAX_STEPS })),
  },
  { additionalProperties: false },
);

type ProgressCardToolOptions = {
  agentSessionKey?: string;
  agentId?: string;
  callGateway?: InProcessGatewayCaller;
};

export function createProgressCardTool(options: ProgressCardToolOptions = {}): AnyAgentTool {
  const gatewayCall = options.callGateway ?? callInProcessGatewayTool;
  return {
    name: "progress_card",
    label: "Progress Card",
    description:
      'Maintain this session\'s progress card: the single durable status surface shown next to the session in OpenClaw\'s UIs, for someone who is not reading the transcript. Create a card only for substantial work with at least two meaningful sequential steps. Do not create a card for greetings, quick questions, or single-step requests, and do not invent steps just to justify one. Existing cards may still be updated or cleared. Each call replaces the whole card. Use either or both parts: `markdown` — for measurable work with a known total, prefer a leading progress bar, e.g. <progress aria-label="PRs reviewed · 12/30" value="12" max="30"></progress>. Use observed completed/total counts for reviews, tests, files, or other work units; prefer these over coarse phase counts. Label what the count measures: reviewed is not merged, and tests finished is not tests passed. Never invent percentages or infer completion from elapsed time. When the total is unknown, use a compact status note or table instead. Follow the bar with a short result, blocker, or next action; use tables for comparisons. The session hovercard pins the bar above the note and shows its aria-label. Other raw HTML is stripped. Known URL? Link it. Don’t leave PRs or issues as bare IDs. And `plan` — an ordered step checklist (pending | in_progress | completed, at most one in_progress) for genuinely sequential work. The checklist is optional: omit it whenever a table, bar, or sentence says it better, and never repeat the same facts in both parts. Call with both parts empty to clear. Update on meaningful change — a batch completed, a step done, a blocker, results in — not every message. Keep the bar and label current in each replacement. Max 8 KB markdown, 50 steps.',
    parameters: ProgressCardToolSchema,
    execute: async (_toolCallId, rawArgs) => {
      const sessionKey = options.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new ToolInputError("progress_card requires an agent session");
      }
      let input;
      try {
        const params = asOptionalObjectRecord(rawArgs);
        input = normalizeProgressCardInput({
          markdown: params?.markdown,
          plan: params?.plan,
        });
      } catch (error) {
        if (error instanceof ProgressCardInputError) {
          throw new ToolInputError(error.message);
        }
        throw error;
      }
      const result = await gatewayCall<ProgressCardPutResult>("progressCard.put", {
        sessionKey,
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        ...(input.markdown ? { markdown: input.markdown } : {}),
        ...(input.steps ? { plan: input.steps } : {}),
      });
      const completed =
        result.card?.steps?.filter((step) => step.status === "completed").length ?? 0;
      const total = result.card?.steps?.length ?? 0;
      const payload = {
        revision: result.card?.revision ?? null,
        steps: total > 0 ? { completed, total } : null,
      };
      const json = jsonResult(payload);
      return recordProgressCardToolOutcome(
        {
          ...json,
          content: [
            {
              type: "text",
              text: !result.card
                ? "Progress card cleared"
                : total > 0
                  ? `Progress card updated (rev ${result.card.revision}, ${completed}/${total} done)`
                  : `Progress card updated (rev ${result.card.revision})`,
            },
            ...json.content,
          ],
        },
        result.card,
      );
    },
  };
}
