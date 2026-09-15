import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import type { LiveVisualProvider } from "../plugins/live-visual-provider.types.js";

export type {
  LiveVisualAudioFormat,
  LiveVisualClock,
  LiveVisualHealth,
  LiveVisualInputEvent,
  LiveVisualOutput,
  LiveVisualProvider,
  LiveVisualSession,
  LiveVisualSessionOpenRequest,
  LiveVisualVideoFormat,
} from "../plugins/live-visual-provider.types.js";

/** Resolves one enabled live-visual provider from the active plugin generation. */
export function resolveLiveVisualProvider(params: {
  providerId: string;
  config?: OpenClawConfig;
}): LiveVisualProvider | undefined {
  return resolvePluginCapabilityProvider({
    key: "liveVisualProviders",
    providerId: params.providerId,
    cfg: params.config,
  });
}
