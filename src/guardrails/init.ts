import { loadGuardrailProvider } from "./index.js";
import { configureGuardrails } from "./runtime.js";
import type { GuardrailsConfig } from "./types.js";

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

let activeGuardrailsSignature: string | null = null;
let pendingGuardrailsSignature: string | null = null;
let pendingGuardrailsGeneration: number | null = null;
let nextGuardrailsGeneration = 1;

function getGuardrailsSignature(guardrails: GuardrailsConfig): string {
  return JSON.stringify(guardrails);
}

function isCurrentPendingGeneration(generation: number): boolean {
  return pendingGuardrailsGeneration === generation;
}

function createStaticGuardrailProvider(params: { name: string; code: string; message: string }) {
  return {
    name: params.name,
    async evaluate() {
      return {
        allow: false,
        reasons: [{ code: params.code, message: params.message }],
      };
    },
  };
}

export const __testing = {
  resetGuardrailsInitState() {
    activeGuardrailsSignature = null;
    pendingGuardrailsSignature = null;
    pendingGuardrailsGeneration = null;
    nextGuardrailsGeneration = 1;
  },
};

export function initGuardrailsFromConfig(guardrails: GuardrailsConfig | undefined, log: Log): void {
  if (!guardrails?.enabled || !guardrails.provider?.use) {
    configureGuardrails(undefined);
    activeGuardrailsSignature = null;
    pendingGuardrailsSignature = null;
    pendingGuardrailsGeneration = null;
    return;
  }

  const signature = getGuardrailsSignature(guardrails);
  if (signature === activeGuardrailsSignature || signature === pendingGuardrailsSignature) {
    return;
  }

  const generation = nextGuardrailsGeneration++;
  pendingGuardrailsSignature = signature;
  pendingGuardrailsGeneration = generation;
  const failClosed = guardrails.failClosed !== false;

  if (failClosed) {
    configureGuardrails(
      createStaticGuardrailProvider({
        name: "guardrails-pending",
        code: "provider_loading",
        message: "guardrail provider is still loading",
      }),
      true,
    );
  } else {
    configureGuardrails(undefined, false);
  }

  loadGuardrailProvider(guardrails.provider)
    .then((provider) => {
      if (!isCurrentPendingGeneration(generation)) {
        return;
      }
      pendingGuardrailsSignature = null;
      pendingGuardrailsGeneration = null;
      activeGuardrailsSignature = signature;
      configureGuardrails(provider, failClosed);
      log.info(`[guardrails] provider '${provider.name}' loaded (failClosed=${failClosed})`);
      if (provider.healthCheck) {
        provider
          .healthCheck()
          .then((health) => {
            if (!health.ok) {
              log.warn(`[guardrails] provider health check failed: ${health.message}`);
            }
          })
          .catch((err) => {
            log.warn(
              `[guardrails] provider health check error: ${err instanceof Error ? err.message : String(err)}`,
            );
          });
      }
    })
    .catch((err) => {
      if (!isCurrentPendingGeneration(generation)) {
        return;
      }
      pendingGuardrailsSignature = null;
      pendingGuardrailsGeneration = null;
      activeGuardrailsSignature = null;
      log.error(
        `[guardrails] failed to load provider: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (failClosed) {
        configureGuardrails(
          createStaticGuardrailProvider({
            name: "guardrails-failed",
            code: "provider_load_failed",
            message: "guardrail provider failed to load (see logs)",
          }),
          true,
        );
      } else {
        configureGuardrails(undefined);
      }
    });
}
