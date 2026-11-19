// "Reset owner access" (enrollment.md, "Owner reset"): the service half of an owner reset,
// only from direct loopback and only with a one-time link code from the account that owns the
// claw at Discovery. `prepare` stages the next Gateway key K_gw' and returns what the new root
// signs; `commit` replaces the root, removes everyone, closes their sessions, revokes their
// tokens and publishes the new root, K_gw' and the current K_gw's RootReset with the code.
//
// Both steps first check the code with Discovery (the published-descriptor read, which does not
// spend it) and that Discovery still publishes this computer's root and binding, which the reset
// evidence must continue. So a reset never commits here when Discovery would refuse to publish
// it: that would cut every remote device off with nothing to reconnect to.
import {
  canonicalize,
  type AuthorityEvent,
  type Channel,
  type JsonValue,
} from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { AuthorityRefusal } from "./authority-result.js";
import type { OpenClawIdAuthority } from "./authority.js";
import type { PublishOutcome } from "./publisher.js";
import type { ResetCommit, ResetPreparation, ResetRemoved } from "./reset-operations.js";
import type { createServiceGatewayKey } from "./service-gateway-key.js";
import type { OpenClawIdStatus } from "./service-status.js";
import type { OpenClawIdRemovalSummary } from "./service.js";

/** A committed reset, with what it cut and Discovery's answer. */
export type ResetCommitResult = {
  ok: true;
  reset: true;
  bindingSeq: number;
  removed: ResetRemoved;
  removal: OpenClawIdRemovalSummary | null;
  publication: PublishOutcome | null;
  /** A step after the stored reset failed; the reset stays, `openclaw id status` shows the rest. */
  followUpError?: string;
};

/** What a reset step takes: the new root's statements (commit) and the owner account's code. */
export type ResetInput = ResetCommit & { code?: string };

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

export function createServiceReset(deps: {
  getStateDir: () => string;
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getAuthority: () => Promise<OpenClawIdAuthority>;
  gatewayKey: ReturnType<typeof createServiceGatewayKey>;
  /** Performs an accepted write's side effects; returns what a removal cut. */
  applyEvents: (events: AuthorityEvent[]) => Promise<OpenClawIdRemovalSummary | undefined>;
  /** Publishes now with the code, which stays held for the retrier until a publish succeeds. */
  publish: (code: string) => Promise<PublishOutcome | undefined>;
  /** Restarts remote access, so the mailbox reader signs with the new K_gw. */
  restartRemoteAccess: () => Promise<OpenClawIdStatus>;
  log: { info: (message: string) => void; warn: (message: string) => void };
}) {
  // Checks that `code` is a live code from the claw owner's account, signed with the staged
  // K_gw' (Discovery accepts any key for this read). The code is not spent.
  const checkOwnerCode = async (
    owner: OpenClawIdAuthority,
    code: string | undefined,
  ): Promise<AuthorityRefusal | undefined> => {
    if (!code) {
      return refusal(
        "needs_link_code",
        "Reset owner access needs a link code from the OpenClaw ID account that owns this claw",
      );
    }
    const record = owner.current();
    if (!record?.discovery.owner_account_id) {
      return refusal(
        "not_published",
        "this claw isn't published to Discovery yet: publish it first (openclaw id publish --code <link-code>), then reset",
      );
    }
    const discoveryUrl = deps.getConfig()?.discoveryUrl;
    if (!discoveryUrl) {
      return refusal("unconfigured", "OpenClaw ID has no Discovery URL on this computer");
    }
    const [{ loadStagedGatewaySigner }, { createDiscoveryClient }] = await Promise.all([
      import("./gateway-key.js"),
      import("./discovery-client.js"),
    ]);
    const signer = await loadStagedGatewaySigner(deps.getStateDir());
    let published: unknown;
    try {
      published = (
        await createDiscoveryClient({ baseUrl: discoveryUrl, signer }).getPublishedDescriptor(
          record.claw_id,
          code,
        )
      ).descriptor;
    } catch (error) {
      // SAFETY: error is a thrown value; an optional code property is compared with ===.
      const failure = (error as { code?: unknown }).code;
      // Discovery answers a code from another account the same as an unknown claw.
      return failure === "not_found" || failure === "code_invalid"
        ? refusal(
            "code_invalid",
            "the link code is unknown, used, expired or not from the account that owns this claw",
          )
        : refusal(
            "discovery_unavailable",
            `couldn't check the link code with Discovery: ${error instanceof Error ? error.message : String(error)}`,
          );
    }
    // SAFETY: an untrusted object; only its root and binding are compared, as canonical JSON.
    const theirs = (published ?? {}) as { root_pub?: unknown; binding?: unknown };
    if (
      theirs.root_pub !== record.authority?.anchor.root_pub ||
      canonicalize((theirs.binding ?? null) as JsonValue) !==
        canonicalize(record.binding as unknown as JsonValue)
    ) {
      return refusal(
        "binding_superseded",
        "Discovery publishes a different owner key or binding for this claw than this computer has (an older backup, or a move on another computer). Bring this computer up to date with openclaw id rebind first, then reset",
      );
    }
    return undefined;
  };

  return async (
    action: "prepare" | "commit",
    channel: Channel | undefined,
    input: ResetInput = { root_pub: undefined, binding: undefined },
  ): Promise<ResetPreparation | ResetCommitResult | AuthorityRefusal> => {
    if (channel !== "local_operator") {
      return refusal(
        "not_local_operator",
        "Reset owner access only works on the computer that runs this claw",
      );
    }
    const owner = await deps.getAuthority();
    if (!owner.current()?.binding) {
      return refusal("not_linked", "this claw is not linked");
    }
    const { stageGatewayKey } = await import("./gateway-key.js");
    const staged = { kGw: await stageGatewayKey(deps.getStateDir()) };
    // This computer's own reasons to refuse (an unpublished move or reset) come first.
    const preparation = await owner.prepareReset(staged);
    if ("ok" in preparation) {
      return preparation;
    }
    const codeRefusal = await checkOwnerCode(owner, input.code);
    if (codeRefusal) {
      return codeRefusal;
    }
    if (action === "prepare") {
      return preparation;
    }
    const key = await deps.gatewayKey.tryLoad();
    if (!key.ok) {
      return refusal(key.refused.reason, key.refused.message);
    }
    const result = await owner.commitReset(input, channel, key.signer, staged);
    if (!result.ok) {
      return result;
    }
    deps.log.info(`openclaw-id: owner access reset (binding ${result.bindingSeq})`);
    const committed: ResetCommitResult = {
      ok: true,
      reset: true,
      bindingSeq: result.bindingSeq,
      removed: result.removed,
      removal: null,
      publication: null,
    };
    // The reset is stored: a failure from here on is reported with it, never as a refusal, so
    // the caller keeps the new kit.
    try {
      // The publication below is the one the reset's publish_snapshot asks for.
      committed.removal =
        (await deps.applyEvents(
          result.events.filter((event) => event.type !== "publish_snapshot"),
        )) ?? null;
      // The stored binding names K_gw' now: the publication signs with it and spends the code.
      committed.publication = (await deps.publish(input.code!)) ?? null;
      const status = await deps.restartRemoteAccess();
      if (status.state === "failed" || status.state === "keys_refused") {
        deps.log.warn(
          `openclaw-id: remote access did not restart after the reset: ${status.reason}`,
        );
      }
      return committed;
    } catch (error) {
      return {
        ...committed,
        followUpError: error instanceof Error ? error.message : String(error),
      };
    }
  };
}
