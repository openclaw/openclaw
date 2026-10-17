import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import { createGatewayWorkerEnvironmentRuntime } from "./server-worker-environment-startup.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";

type RuntimeParams = Parameters<typeof createGatewayWorkerEnvironmentRuntime>[0];
type Startup = RuntimeParams["startup"];
type Intent = Parameters<Startup["store"]["createIntent"]>[0];
type IntentOptions = Omit<Intent, "provisionOperationId"> &
  Partial<Pick<Intent, "provisionOperationId">>;
type TransitionPatch = Parameters<Startup["store"]["transition"]>[0]["patch"];

export async function provisionStartupWorker(
  startup: Startup,
  intent: IntentOptions,
  patch?: TransitionPatch,
) {
  const { environmentId } = await startup.store.createIntent({
    provisionOperationId: `provision:${intent.environmentId}`,
    ...intent,
  });
  return startup.store.transition({ environmentId, from: "requested", to: "provisioning", patch });
}

export async function createReadyStartupWorker(
  startup: Startup,
  options: IntentOptions & { ready: TransitionPatch },
) {
  const { ready, ...intent } = options;
  const record = await provisionStartupWorker(startup, intent);
  return startup.store.transition({
    environmentId: record.environmentId,
    from: record.state,
    to: "ready",
    patch: {
      sshEndpoint: null,
      sharedHost: true,
      bootstrapReceipt: workerStartupReceipt(),
      ...ready,
    },
  });
}

export function createWorkerStartupRuntime(
  startup: RuntimeParams["startup"],
  getPluginRegistry: RuntimeParams["getPluginRegistry"],
  overrides: Partial<Omit<RuntimeParams, "startup" | "getPluginRegistry">> = {},
) {
  return createGatewayWorkerEnvironmentRuntime({
    scheduler: createTestGatewayScheduler(),
    getPluginRegistry,
    getPortalRuntime: () => undefined,
    resolveGatewayContext: () => undefined,
    desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
    startup,
    log: { child: () => ({ info: () => {}, warn: () => {} }) },
    ...overrides,
  });
}

function workerStartupReceipt() {
  return {
    bundleHash: "a".repeat(64),
    openclawVersion: "2026.8.14",
    protocolFeatures: ["worker-heartbeat-v1"],
    installKind: "bundle" as const,
  };
}

export function workerStartupCredential(token: string, sessionId: string | null = null) {
  return {
    credentialHash: hashWorkerCredential(token),
    sessionId,
    rpcSetVersion: 1,
    expiresAtMs: Date.now() + 60_000,
  };
}
