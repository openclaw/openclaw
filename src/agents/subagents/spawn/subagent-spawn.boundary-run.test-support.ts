import { expectDefined } from "@openclaw/normalization-core";
import { onTestFinished } from "vitest";
import type { GatewayRequestContext } from "../../../gateway/server-methods/types.js";
import { resolvePreparedRunAdmission } from "../../admitted-run-context.js";
import type { runEmbeddedAgent } from "../../embedded-agent-runner/run.js";
import {
  recordSpawnBoundaryFinal,
  type NativePluginSpawnTestOptions,
} from "./subagent-spawn.production-boundary.test-support.js";

type Run = Parameters<typeof runEmbeddedAgent>[0];
type Bound = Awaited<ReturnType<NativePluginSpawnTestOptions["createBoundParent"]>>;

export function admitEmbeddedRun(params: Run) {
  return resolvePreparedRunAdmission({
    runId: params.runId,
    runtimeKind: "embedded",
    admittedRunContext: params.admittedRunContext,
    preparedRunAdmission: params.preparedRunAdmission,
  });
}

export function recordFinal(bound: Bound, params: Run, text: string) {
  return recordSpawnBoundaryFinal({
    storePath: bound.storePath,
    sessionKey: expectDefined(params.sessionKey, "final reply session"),
    runId: params.runId,
    text,
  });
}

export async function materializeSessionProjection(bound: Bound, context: GatewayRequestContext) {
  const { bindSessionRowProjection } =
    await import("../../../gateway/session-row-projection-access.js");
  const { createSessionRowProjection } = await import("../../../gateway/session-row-projection.js");
  const projection = await createSessionRowProjection({ cfg: bound.cfg, modelCatalog: [] });
  onTestFinished(async () => {
    projection.dispose();
    await projection.ensureMaterialized();
  });
  bindSessionRowProjection(context, () => projection);
  await projection.ensureMaterialized();
}
