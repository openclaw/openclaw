import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type PluginSharedStateResourceHost = {
  assertSharedStateAdmission(): void;
  trackSharedStateWork<T>(run: () => Promise<T>): Promise<T>;
};
type ResolveHost = () => PluginSharedStateResourceHost | undefined;

// State workers consume the host's admission without importing its plugin/runtime graph.
const admission = resolveGlobalSingleton<{ resolveHost?: ResolveHost }>(
  Symbol.for("openclaw.pluginSharedStateAdmission"),
  () => ({}),
);

export function bindPluginSharedStateAdmission(resolveHost: ResolveHost): void {
  admission.resolveHost = resolveHost;
}

export function getPluginSharedStateResourceHost(): PluginSharedStateResourceHost | undefined {
  return admission.resolveHost?.();
}

export function runPluginSharedStateWork<T>(run: () => Promise<T>): Promise<T> {
  const host = getPluginSharedStateResourceHost();
  return host ? host.trackSharedStateWork(run) : run();
}
