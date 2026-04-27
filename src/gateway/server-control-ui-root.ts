import path from "node:path";
import {
  ensureControlUiAssetsBuilt,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ControlUiRootState } from "./control-ui.js";

export async function resolveGatewayControlUiRootState(params: {
  controlUiRootOverride?: string;
  controlUiEnabled: boolean;
  gatewayRuntime: RuntimeEnv;
  log: { warn: (message: string) => void };
}): Promise<ControlUiRootState | undefined> {
  if (params.controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(params.controlUiRootOverride);
    const resolvedOverridePath = path.resolve(params.controlUiRootOverride);
    if (!resolvedOverride) {
      params.log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
    }
    return resolvedOverride
      ? { kind: "resolved", path: resolvedOverride }
      : { kind: "invalid", path: resolvedOverridePath };
  }

  if (!params.controlUiEnabled) {
    return undefined;
  }

  const resolveRoot = () =>
    resolveControlUiRootSync({
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    });

  let resolvedRoot = resolveRoot();
  if (!resolvedRoot) {
    const ensureResult = await ensureControlUiAssetsBuilt(params.gatewayRuntime);
    if (!ensureResult.ok && ensureResult.message) {
      params.log.warn(`gateway: ${ensureResult.message}`);
    }
    resolvedRoot = resolveRoot();
  }

  if (!resolvedRoot) {
    return { kind: "missing" };
  }

  return {
    kind: isPackageProvenControlUiRootSync(resolvedRoot, {
      moduleUrl: import.meta.url,
      argv1: process.argv[1],
      cwd: process.cwd(),
    })
      ? "bundled"
      : "resolved",
    path: resolvedRoot,
  };
}
