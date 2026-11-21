import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import type { CronServiceContract } from "./service-contract.js";
import type { WhatsAppAutomationPeer } from "./whatsapp-automation.js";

type AutomationTurn = WhatsAppAutomationPeer & {
  cron: CronServiceContract;
  getConfig(): OpenClawConfig;
  agentId: string;
  sessionKey: string;
  assertCurrent(): void;
};
const marker = Symbol.for("openclaw.whatsapp.private-automation-input");
const bindings = resolveGlobalSingleton(
  Symbol.for("openclaw.whatsapp.private-automation-bindings"),
  () => ({
    inputs: new WeakMap<object, AutomationTurn>(),
    current: new AsyncLocalStorage<{ runId: string; turn: AutomationTurn; active: boolean }>(),
  }),
);

export function bindWhatsAppAutomationInput(context: object, turn: AutomationTurn) {
  const token = Object.freeze({});
  bindings.inputs.set(token, turn);
  Object.assign(context, { [marker]: token });
}

export function readWhatsAppAutomationInput(context: object, sessionKey: string) {
  const token: unknown = Reflect.get(context, marker);
  const turn = token && typeof token === "object" ? bindings.inputs.get(token) : undefined;
  return turn?.sessionKey === sessionKey ? turn : undefined;
}

async function withWhatsAppAutomationTurn<T>(
  runId: string,
  turn: AutomationTurn,
  run: () => Promise<T>,
) {
  const scope = { runId, turn, active: true };
  try {
    return await bindings.current.run(scope, run);
  } finally {
    scope.active = false;
  }
}

export type RunWithWhatsAppAutomation = <T>(
  runId: string,
  sessionKey: string | undefined,
  run: () => Promise<T>,
) => Promise<T>;

export function prepareWhatsAppAutomationRun(
  context: object,
  sessionKey: string,
): RunWithWhatsAppAutomation | undefined {
  const source = readWhatsAppAutomationInput(context, sessionKey);
  if (!source) {
    return undefined;
  }
  return async (runId, key, run) => {
    if (key !== source.sessionKey) {
      return run();
    }
    source.assertCurrent();
    const { hasWhatsAppAutomationPermission } = await import("./whatsapp-automation.js");
    if (!(await hasWhatsAppAutomationPermission(source.getConfig(), source))) {
      return run();
    }
    source.assertCurrent();
    return withWhatsAppAutomationTurn(runId, source, run);
  };
}

export function getWhatsAppAutomationTurn(runId?: string, sessionKey?: string) {
  const scope = bindings.current.getStore();
  return scope?.active && scope.runId === runId && scope.turn.sessionKey === sessionKey
    ? scope.turn
    : undefined;
}
