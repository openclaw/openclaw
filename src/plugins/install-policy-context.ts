// Builds payloads for the plugin-runtime before_install lifecycle hook.
import type { PluginHookBeforeInstallContext, PluginHookBeforeInstallEvent } from "./types.js";

type BeforeInstallHookPayloadParams = Omit<PluginHookBeforeInstallEvent, "builtinScan"> &
  Partial<Pick<PluginHookBeforeInstallEvent, "builtinScan">>;

export function createBeforeInstallHookPayload(params: BeforeInstallHookPayloadParams): {
  ctx: PluginHookBeforeInstallContext;
  event: PluginHookBeforeInstallEvent;
} {
  const event: PluginHookBeforeInstallEvent = {
    targetType: params.targetType,
    targetName: params.targetName,
    sourcePath: params.sourcePath,
    sourcePathKind: params.sourcePathKind,
    ...(params.origin ? { origin: params.origin } : {}),
    request: params.request,
    builtinScan: params.builtinScan ?? {
      status: "ok",
      scannedFiles: 0,
      critical: 0,
      warn: 0,
      info: 0,
      findings: [],
    },
    ...(params.skill ? { skill: params.skill } : {}),
    ...(params.plugin ? { plugin: params.plugin } : {}),
  };

  const ctx: PluginHookBeforeInstallContext = {
    targetType: params.targetType,
    requestKind: params.request.kind,
    ...(params.origin ? { origin: params.origin } : {}),
  };

  return { event, ctx };
}
