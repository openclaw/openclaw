import type {
  ErrorShape,
  SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { publishSessionPatchEffects } from "./sessions-patch-effects.js";
import type { MutationOutcome } from "./sessions-patch-types.js";
import type { GatewayRequestContext } from "./types.js";

type MutationEffectTarget = {
  canonicalKey: string;
  fullPatch: SessionsPatchParams;
  index: number;
  requestedAgentId?: string;
  targetAgentId: string;
};

/** Publish committed effects, then surface any active-runtime permission failures. */
export async function finalizeSessionPatchMutationEffects(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  callerScopes: readonly string[];
  callerCanManageCron: boolean;
  category: SessionsPatchParams["category"];
  targets: readonly MutationEffectTarget[];
  outcomes: Array<MutationOutcome | undefined>;
  permissionErrors: ReadonlyMap<number, ErrorShape>;
}): Promise<void> {
  await publishSessionPatchEffects({
    cfg: params.cfg,
    context: params.context,
    callerScopes: params.callerScopes,
    callerCanManageCron: params.callerCanManageCron,
    category: params.category,
    targets: params.targets.flatMap((target) => {
      const outcome = params.outcomes[target.index];
      return outcome?.ok && outcome.applied
        ? [{ target, entry: outcome.entry, accessChanged: outcome.accessChanged }]
        : [];
    }),
  });

  // Runtime application can fail after commit. Publish every saved field's
  // normal effects before returning the application error to the caller.
  for (const [index, error] of params.permissionErrors) {
    params.outcomes[index] = { ok: false, error };
  }
}
