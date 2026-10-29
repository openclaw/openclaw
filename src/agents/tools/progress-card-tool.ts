import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { getAgentToolAssistantTurnId } from "../../../packages/agent-core/src/tool-execution-context.js";
import {
  PROGRESS_CARD_MAX_STEPS,
  ProgressCardStepSchema,
  type ProgressCardPutResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { getAgentRunLifecycleGeneration } from "../../infra/agent-run-registry.js";
import {
  normalizeProgressCardInput,
  ProgressCardInputError,
} from "../../session-cards/progress-card-input.js";
import {
  ProgressWorkIntentSchema,
  normalizeProgressWorkIntent,
  type WorkSnapshot,
} from "../../session-cards/progress-card-work-intent.js";
import type { ProgressOwner } from "../../session-cards/progress-card-work.js";
import { bindAgentToolReplaySafety } from "../tool-replay-safety.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, ToolInputError } from "./common.js";
import {
  captureGatewayToolCallerAssertion,
  getGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";
import { callInProcessGatewayTool, callAgentToolGatewayRequest } from "./in-process-gateway.js";
import { recordProgressCardToolOutcome } from "./progress-card-tool-outcome.js";

const ProgressCardToolSchema = Type.Object(
  {
    work: Type.Optional(ProgressWorkIntentSchema),
    markdown: Type.Optional(Type.String()),
    plan: Type.Optional(Type.Array(ProgressCardStepSchema, { maxItems: PROGRESS_CARD_MAX_STEPS })),
  },
  { additionalProperties: false },
);

type ProgressCardToolOptions = {
  agentSessionKey?: string;
  agentId?: string;
  workOwner?: ProgressOwner;
  workTarget?: import("../../config/sessions/transcript-target-binding.js").CapturedSessionTranscriptTargetBinding;
  onWorkSaved?: (snapshot: WorkSnapshot) => void;
  readWork?: () => WorkSnapshot;
};

export function createProgressCardTool(options: ProgressCardToolOptions = {}): AnyAgentTool {
  const tool: AnyAgentTool = {
    name: "progress_card",
    label: "Progress Card",
    description:
      'Maintain this session\'s progress card: the single durable status surface shown next to the session in OpenClaw\'s UIs, for someone who is not reading the transcript. Create a card only for substantial work with at least two meaningful sequential steps. Do not create a card for greetings, quick questions, or single-step requests, and do not invent steps just to justify one. Existing cards may still be updated or cleared. Each call replaces the whole displayed card, not the retained task. The following retained-work semantics apply only when native admission supplies a retained-work owner and assistant-turn custody; otherwise calls are display-only and explicit work intent is not admitted. With that custody, a first plan begins retained work; subsequent plans reconcile every unresolved step. Use work.action begin/replace with scope for a new task, reconcile with disposition completed only after all obligations are reconciled, paused-blocked with reason and resumeCondition for a genuine hold, reconcile with disposition actionable for explicit resume, or retire for cancellation. Omitted work and note-only/empty plan never complete, cancel or resume retained work. Use either or both parts: `markdown` — for measurable work with a known total, prefer a leading progress bar, e.g. <progress aria-label="PRs reviewed · 12/30" value="12" max="30"></progress>. Use observed completed/total counts for reviews, tests, files, or other work units; prefer these over coarse phase counts. Label what the count measures: reviewed is not merged, and tests finished is not tests passed. Never invent percentages or infer completion from elapsed time. When the total is unknown, use a compact status note or table instead. Follow the bar with a short result, blocker, or next action; use tables for comparisons. The session hovercard pins the bar above the note and shows its aria-label. Other raw HTML is stripped. Known URL? Link it. Don’t leave PRs or issues as bare IDs. And `plan` — an ordered step checklist (pending | in_progress | completed, at most one in_progress) for genuinely sequential work. The checklist is optional: omit it whenever a table, bar, or sentence says it better, and never repeat the same facts in both parts. If no authorized step can proceed because of a pause or external dependency, preserve the unfinished work, blocker, owner, and resume condition in markdown and omit plan; do not mark blocked work completed. Call with both parts empty to clear. Update on meaningful change — a batch completed, a step done, a blocker, results in — not every message. Keep the bar and label current in each replacement. Max 8 KB markdown, 50 steps.',
    parameters: ProgressCardToolSchema,
    execute: async (toolCallId, rawArgs) => {
      const sessionKey = options.agentSessionKey?.trim();
      if (!sessionKey) {
        throw new ToolInputError("progress_card requires an agent session");
      }
      let input;
      let intent;
      try {
        const params = asOptionalObjectRecord(rawArgs);
        intent = normalizeProgressWorkIntent(params?.work);
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
      const params = {
        sessionKey,
        ...(options.agentId !== undefined ? { agentId: options.agentId } : {}),
        ...(input.markdown ? { markdown: input.markdown } : {}),
        ...(input.steps ? { plan: input.steps } : {}),
      };
      const caller = getGatewayToolCallerIdentity();
      const assertCurrent = captureGatewayToolCallerAssertion();
      let snapshot: WorkSnapshot = {
        kind: "unavailable",
        reason: "Display-only tool has no admitted retained-work custody",
      };
      let result: ProgressCardPutResult;
      let committedSource:
        | import("../../session-cards/progress-card-work.js").WorkSource
        | undefined;
      if (options.workOwner) {
        const turnId = getAgentToolAssistantTurnId();
        if (!caller?.operationalRunInstance || !assertCurrent || !turnId || !options.workTarget) {
          throw new ToolInputError("Retained work requires an admitted assistant-turn source");
        }
        assertCurrent();
        const observed = options.readWork?.();
        if (!observed || observed.kind === "unavailable") {
          throw new ToolInputError(
            "Retained work fence is unavailable; reconcile the original owner",
          );
        }
        const expected =
          observed.kind === "retained"
            ? { generation: observed.state.generation, revision: observed.state.revision }
            : null;
        const source = {
          runId: caller.operationalRunInstance.runId,
          turnId,
          toolCallId,
          processGeneration: getAgentRunLifecycleGeneration(),
        };
        const committed = await callAgentToolGatewayRequest<
          ProgressCardPutResult & { work: WorkSnapshot }
        >({
          method: "progressCard.reconcileWork",
          params: { ...params, ...(intent ? { work: intent } : {}) },
          agentToolCaller: {
            agentId: caller.agentId,
            sessionKey: caller.sessionKey,
            assertCurrent,
            progressWork: {
              target: options.workTarget,
              owner: options.workOwner,
              expected,
              source,
            },
          },
          sessionMutationCommitGuard: assertCurrent,
        });
        assertCurrent();
        const latest = options.readWork?.();
        if (
          !latest ||
          latest.kind === "unavailable" ||
          (latest.kind === "retained"
            ? latest.state.generation !== expected?.generation ||
              latest.state.revision !== expected?.revision
            : expected !== null)
        ) {
          throw new ToolInputError(
            "Retained work receipt was superseded; observe the committed owner before retrying",
          );
        }
        result = committed;
        snapshot = committed.work;
        committedSource = source;
      } else {
        if (intent) {
          throw new ToolInputError("Explicit work intent requires an admitted retained-work owner");
        }
        // Compatibility is selected before dispatch; an uncertain managed write never falls back.
        result = await callInProcessGatewayTool<ProgressCardPutResult>("progressCard.put", params);
      }
      const completed =
        result.card?.steps?.filter((step) => step.status === "completed").length ?? 0;
      const total = result.card?.steps?.length ?? 0;
      options.onWorkSaved?.(snapshot);
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
        snapshot,
        committedSource,
      );
    },
  };
  return bindAgentToolReplaySafety(tool, "managed-progress");
}
