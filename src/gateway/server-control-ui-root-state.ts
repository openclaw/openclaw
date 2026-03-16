import path from "node:path";
import {
  ensureControlUiAssetsBuilt,
  isPackageProvenControlUiRootSync,
  resolveControlUiRootOverrideSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ControlUiRootState } from "./control-ui.js";

type ResolveGatewayControlUiRootStateParams = {
  controlUiEnabled: boolean;
  controlUiRootOverride?: string;
  gatewayRuntime: RuntimeEnv;
  log: { warn: (message: string) => void };
  runtimePathContext: {
    moduleUrl: string;
    argv1: string | undefined;
    cwd: string;
  };
};

export async function resolveGatewayControlUiRootState(
  params: ResolveGatewayControlUiRootStateParams,
): Promise<ControlUiRootState | undefined> {
  if (params.controlUiRootOverride) {
    const resolvedOverride = resolveControlUiRootOverrideSync(params.controlUiRootOverride);
    const resolvedOverridePath = path.resolve(params.controlUiRootOverride);
    if (!resolvedOverride) {
      params.log.warn(`gateway: controlUi.root not found at ${resolvedOverridePath}`);
      return { kind: "invalid", path: resolvedOverridePath };
    }
    return { kind: "resolved", path: resolvedOverride };
  }

  if (!params.controlUiEnabled) {
    return undefined;
  }

  let resolvedRoot = resolveControlUiRootSync(params.runtimePathContext);
  if (!resolvedRoot) {
    const ensureResult = await ensureControlUiAssetsBuilt(params.gatewayRuntime);
    if (!ensureResult.ok && ensureResult.message) {
      params.log.warn(`gateway: ${ensureResult.message}`);
    }
    resolvedRoot = resolveControlUiRootSync(params.runtimePathContext);
  }

  if (!resolvedRoot) {
    return { kind: "missing" };
  }
  return {
    kind: isPackageProvenControlUiRootSync(resolvedRoot, params.runtimePathContext)
      ? "bundled"
      : "resolved",
    path: resolvedRoot,
  };
}
