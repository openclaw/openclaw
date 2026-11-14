// "Reset owner access" (enrollment.md, "Owner reset"): the service half of an owner reset,
// only from direct loopback. `prepare` returns what the new root signs; `commit` replaces the
// root, removes everyone, closes their sessions, revokes their tokens and publishes the new
// root with K_gw's RootReset.
import type { AuthorityEvent, Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityRefusal } from "./authority-result.js";
import type { OpenClawIdAuthority } from "./authority.js";
import type { PublishOutcome } from "./publisher.js";
import type { ResetCommit, ResetPreparation, ResetRemoved } from "./reset-operations.js";
import type { createServiceGatewayKey } from "./service-gateway-key.js";
import type { OpenClawIdRemovalSummary } from "./service.js";

/** A committed reset, with what it cut and Discovery's answer. */
export type ResetCommitResult = {
  ok: true;
  reset: true;
  bindingSeq: number;
  removed: ResetRemoved;
  removal: OpenClawIdRemovalSummary | null;
  publication: PublishOutcome | null;
};

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

export function createServiceReset(deps: {
  getAuthority: () => Promise<OpenClawIdAuthority>;
  gatewayKey: ReturnType<typeof createServiceGatewayKey>;
  /** Performs an accepted write's side effects; returns what a removal cut. */
  applyEvents: (events: AuthorityEvent[]) => Promise<OpenClawIdRemovalSummary | undefined>;
  /** Publishes now and keeps a failure pending for the retrier. */
  publish: () => Promise<PublishOutcome | undefined>;
  log: { info: (message: string) => void };
}) {
  /** `guard` throws once the caller's live authority is gone; it is checked at the write. */
  return async (
    action: "prepare" | "commit",
    channel: Channel | undefined,
    input: ResetCommit = { root_pub: undefined, binding: undefined },
    guard?: () => void,
  ): Promise<ResetPreparation | ResetCommitResult | AuthorityRefusal> => {
    if (channel !== "local_operator") {
      return refusal(
        "not_local_operator",
        "Reset owner access only works on the computer that runs this claw",
      );
    }
    const owner = await deps.getAuthority();
    if (action === "prepare") {
      return await owner.prepareReset();
    }
    const key = await deps.gatewayKey.tryLoad();
    if (!key.ok) {
      return refusal(key.refused.reason, key.refused.message);
    }
    const result = await owner.commitReset(input, channel, key.signer, guard);
    if (!result.ok) {
      return result;
    }
    deps.log.info(`openclaw-id: owner access reset (binding ${result.bindingSeq})`);
    // The publication below is the one the reset's publish_snapshot asks for.
    const removal = await deps.applyEvents(
      result.events.filter((event) => event.type !== "publish_snapshot"),
    );
    const publication = await deps.publish();
    return {
      ok: true,
      reset: true,
      bindingSeq: result.bindingSeq,
      removed: result.removed,
      removal: removal ?? null,
      publication: publication ?? null,
    };
  };
}
