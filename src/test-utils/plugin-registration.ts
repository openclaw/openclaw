import { createCapturedPluginRegistration } from "../plugins/captured-registration.js";
import type { OpenClawPluginApi, ProviderPlugin } from "../plugins/types.js";

export { createCapturedPluginRegistration };

export function registerSingleProviderPlugin(params: {
  register(api: OpenClawPluginApi): void;
}): ProviderPlugin {
  const captured = createCapturedPluginRegistration();
  params.register(captured.api);
  const provider = captured.providers[0];
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}
