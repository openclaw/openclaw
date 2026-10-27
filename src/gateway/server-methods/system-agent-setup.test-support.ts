import { expectDefined } from "@openclaw/normalization-core";
import { Compile } from "typebox/compile";
import { expect } from "vitest";
import type {
  WizardNextParams,
  WizardNextResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { WizardNextResultSchema } from "../../../packages/gateway-protocol/src/schema/wizard.js";
import type { WizardSession } from "../../wizard/session.js";
import { systemAgentHandlers } from "./system-agent.js";
import type { GatewayRequestContext } from "./types.js";
import { wizardHandlers } from "./wizard.js";

const validateWizardResult = Compile(WizardNextResultSchema);

export function makeContext() {
  const wizardSessions = new Map<string, WizardSession>();
  return {
    wizardSessions,
    context: {
      getRuntimeConfig: () => ({}),
      wizardSessions,
      findRunningWizard: () => undefined,
      purgeWizardSession: (id: string) => wizardSessions.delete(id),
    } as unknown as GatewayRequestContext,
  };
}

export async function invoke(method: string, context: GatewayRequestContext, params: unknown) {
  const calls: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
  const respond = (ok: boolean, payload?: unknown, error?: unknown) => {
    calls.push({ ok, payload, error });
  };
  const handler = expectDefined(systemAgentHandlers[method] ?? wizardHandlers[method], method);
  await handler({ params, respond, context } as never);
  return calls;
}

export async function callWizardNext(
  context: GatewayRequestContext,
  params: WizardNextParams,
): Promise<WizardNextResult> {
  const calls = await invoke("wizard.next", context, params);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.ok).toBe(true);
  const payload = calls[0]?.payload;
  if (!validateWizardResult.Check(payload)) {
    throw new Error("wizard.next returned an invalid result");
  }
  return payload;
}

export function answerWizard(
  context: GatewayRequestContext,
  sessionId: string,
  frame: WizardNextResult,
  value?: unknown,
) {
  return callWizardNext(context, {
    sessionId,
    answer: { stepId: expectDefined(frame.step, "wizard step").id, value },
  });
}

export function startActivation(
  context: GatewayRequestContext,
  sessionId: string,
  modelRef = "example/model",
) {
  return invoke("openclaw.setup.activate.start", context, {
    sessionId,
    kind: "codex-cli",
    modelRef,
  });
}
