import type { OpenClawConfig } from "../config/config.js";
import type { PreparedSecretsRuntimeSnapshot } from "../secrets/runtime.js";

type SecretsReloaderStateCode = "SECRETS_RELOADER_DEGRADED" | "SECRETS_RELOADER_RECOVERED";
type SecretsActivationReason = "startup" | "reload" | "restart-check";

type GatewaySecretsActivationControllerDeps = {
  prepareSecretsRuntimeSnapshot: (params: {
    config: OpenClawConfig;
  }) => Promise<PreparedSecretsRuntimeSnapshot>;
  activateRuntimeSnapshot: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  onAuthSurfaceDiagnostics: (snapshot: PreparedSecretsRuntimeSnapshot) => void;
  log: {
    info: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
  };
  emitStateEvent: (code: SecretsReloaderStateCode, message: string, config: OpenClawConfig) => void;
};

export function createGatewaySecretsActivationController(
  deps: GatewaySecretsActivationControllerDeps,
): {
  activateRuntimeSecrets: (
    config: OpenClawConfig,
    params: { reason: SecretsActivationReason; activate: boolean },
  ) => Promise<PreparedSecretsRuntimeSnapshot>;
} {
  let secretsDegraded = false;
  let activationTail: Promise<void> = Promise.resolve();

  const runWithActivationLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const run = activationTail.then(operation, operation);
    activationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return await run;
  };

  const activateRuntimeSecrets = async (
    config: OpenClawConfig,
    params: { reason: SecretsActivationReason; activate: boolean },
  ): Promise<PreparedSecretsRuntimeSnapshot> =>
    await runWithActivationLock(async () => {
      try {
        const prepared = await deps.prepareSecretsRuntimeSnapshot({ config });
        if (params.activate) {
          deps.activateRuntimeSnapshot(prepared);
          deps.onAuthSurfaceDiagnostics(prepared);
        }
        for (const warning of prepared.warnings) {
          deps.log.warn(`[${warning.code}] ${warning.message}`);
        }
        if (secretsDegraded) {
          const recoveredMessage =
            "Secret resolution recovered; runtime remained on last-known-good during the outage.";
          deps.log.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
          deps.emitStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
        }
        secretsDegraded = false;
        return prepared;
      } catch (err) {
        const details = String(err);
        if (!secretsDegraded) {
          deps.log.error(`[SECRETS_RELOADER_DEGRADED] ${details}`);
          if (params.reason !== "startup") {
            deps.emitStateEvent(
              "SECRETS_RELOADER_DEGRADED",
              `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`,
              config,
            );
          }
        } else {
          deps.log.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
        }
        secretsDegraded = true;
        if (params.reason === "startup") {
          throw new Error(`Startup failed: required secrets are unavailable. ${details}`, {
            cause: err,
          });
        }
        throw err;
      }
    });

  return { activateRuntimeSecrets };
}
