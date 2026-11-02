import { readRuntimeConfig } from "../../config/runtime-snapshot.js";
import type { PostSessionNoticeParams } from "../../sessions/session-notice.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import { getPluginRuntimeGatewayRequestScope } from "./gateway-request-scope.js";

// Delivery and transcript code stays lazy: most plugins never post a notice.
const loadSessionNotice = createLazyRuntimeModule(() => import("../../sessions/session-notice.js"));

/** Capture the session generation a later notice must still match. */
export async function capturePluginSessionGeneration(params: {
  agentId: string;
  sessionKey: string;
  storePath?: string;
}) {
  const assertCurrent = getPluginRuntimeGatewayRequestScope()?.assertSystemOwnerCurrent;
  assertCurrent?.();
  const notices = await loadSessionNotice();
  const generation = await notices.captureSessionGeneration({
    ...params,
    config: readRuntimeConfig(),
  });
  assertCurrent?.();
  return generation;
}

/**
 * Post the calling plugin's notice. The plugin id and live owner check come from the
 * registry-bound runtime scope, never from the plugin's arguments.
 */
export async function postPluginSessionNotice(params: PostSessionNoticeParams) {
  const scope = getPluginRuntimeGatewayRequestScope();
  if (!scope?.pluginId) {
    throw new Error("Plugin session notices require an active plugin runtime scope.");
  }
  const assertCurrent = scope.assertSystemOwnerCurrent;
  assertCurrent?.();
  const notices = await loadSessionNotice();
  // Forward only the documented fields; host authority never comes from plugin input.
  const { generation, notice, idempotencyKey, systemEvent, deliver } = params;
  return await notices.postSessionNotice({
    generation,
    notice,
    idempotencyKey,
    ...(systemEvent !== undefined ? { systemEvent } : {}),
    ...(deliver !== undefined ? { deliver } : {}),
    config: readRuntimeConfig(),
    pluginId: scope.pluginId,
    pluginOwner: assertCurrent ? { assertCurrent } : {},
  });
}
