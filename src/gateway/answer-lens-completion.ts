import type { AdmittedRunOperatorAuthority } from "../agents/admitted-run-context.js";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import {
  resolveIsolatedCompletionProvider,
  resolveIsolatedCompletionRoute,
} from "../agents/isolated-completion-route.js";
import { runIsolatedCompletion } from "../agents/isolated-completion.js";
import { prepareUtilityCompletionForAgent } from "../agents/utility-completion.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { answerLensPrompt, type AnswerLensSettings } from "./answer-lens.js";

export async function completeAnswerLens(
  params: AnswerLensSettings & {
    cfg: OpenClawConfig;
    agentId: string;
    source: string;
    assertCurrent: () => void;
    operatorAuthority: AdmittedRunOperatorAuthority;
    signal: AbortSignal;
    onText?: (text: string) => void;
  },
) {
  const prepared = await prepareUtilityCompletionForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
    useUtilityModel: "required",
  });
  params.assertCurrent();
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
  const { provider, runtimeOverride } = resolveIsolatedCompletionProvider(prepared);
  const route = await resolveIsolatedCompletionRoute({
    ...prepared,
    workspaceDir,
    provider,
    runtimeOverride,
    explicitRuntimeOverride: prepared.agentHarnessRuntimeOverride,
  });
  params.assertCurrent();
  const runtime = route.cliOwner ?? route.selection.selectedHarnessId;
  if (runtime === "agentsapi") {
    throw new Error("The selected runtime cannot provide tool-free Answer Lens.");
  }
  // No fallback runner: one selected model, one tool-free operation.
  const result = await runIsolatedCompletion({
    ...prepared,
    provider,
    workspaceDir,
    agentHarnessRuntimeOverride: runtime,
    purpose: "answer-lens",
    systemPrompt: answerLensPrompt(params),
    prompt: JSON.stringify({ answer: params.source }),
    timeoutMs: 30_000,
    answerTokenBudget: 6_000,
    assertCurrent: params.assertCurrent,
    operatorAuthority: params.operatorAuthority,
    abortSignal: params.signal,
    onText: params.onText,
  });
  params.assertCurrent();
  if (!result.text.trim() || result.text.length > 48_000) {
    throw new Error("Invalid Answer Lens output.");
  }
  return result;
}
