import type { GuardrailsConfig } from "./types.js";
import { loadGuardrailProvider } from "./index.js";
import { configureGuardrails } from "../agents/pi-tools.before-tool-call.js";

type Log = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
};

export function initGuardrailsFromConfig(guardrails: GuardrailsConfig | undefined, log: Log): void {
  if (!guardrails?.enabled || !guardrails.provider?.use) {
    return;
  }

  const failClosed = guardrails.failClosed !== false;

  if (failClosed) {
    configureGuardrails(
      {
        name: "guardrails-pending",
        async evaluate() {
          return {
            allow: false,
            reasons: [{ code: "provider_loading", message: "guardrail provider is still loading" }],
          };
        },
      },
      true,
    );
  }

  loadGuardrailProvider(guardrails.provider)
    .then((provider) => {
      configureGuardrails(provider, failClosed);
      log.info(`[guardrails] provider '${provider.name}' loaded (failClosed=${failClosed})`);
      if (provider.healthCheck) {
        provider.healthCheck()
          .then((health) => {
            if (!health.ok) log.warn(`[guardrails] provider health check failed: ${health.message}`);
          })
          .catch((err) => {
            log.warn(`[guardrails] provider health check error: ${err instanceof Error ? err.message : String(err)}`);
          });
      }
    })
    .catch((err) => {
      log.error(`[guardrails] failed to load provider: ${err instanceof Error ? err.message : String(err)}`);
      if (!failClosed) {
        configureGuardrails(undefined);
      }
    });
}
