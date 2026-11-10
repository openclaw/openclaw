// "Move to new keys" (`openclaw id rebind`): the Gateway half of the re-bind ceremony
// (enrollment.md, "Re-bind"). Only the operator on this machine runs it (direct loopback),
// and it works with remote access off, which is the lost-key case.
//
// 1. prepare stages the next keys: K_gw' in `gateway.key.next` (here) and K_srv' in
//    `endpoint.key.next` (by a one-shot tunnel child; the Gateway never reads that file).
//    Preparing again reuses them. The authority returns what R signs; nothing is committed.
// 2. The CLI or local Control UI derives R from the recovery kit and signs the binding.
// 3. commit stages again (the same keys), and the authority stores the binding only if it
//    names exactly those keys at the next binding_seq. From then on the stored binding alone
//    says which keys are current: the key rule at every start promotes the `.next` files, so
//    a crash anywhere after the commit finishes the move on the next start.
// 4. Remote access restarts on the new keys and the publication owner publishes the new
//    descriptor with its snapshot; until Discovery has it, the publication stays pending.
//
// The steps run one at a time (staging, commit and cancel touch the same key files), and a
// re-bind starts only once the claw's registration at Discovery is settled: a registration
// whose receipt was lost can be recovered only with the K_gw Discovery registered.
import fs from "node:fs";
import type { Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { GatewayOpenClawIdConfig } from "../../config/types.gateway.js";
import type { AuthorityRefusal } from "./authority-result.js";
import type { OpenClawIdAuthority } from "./authority.js";
import { createDiscoveryClient } from "./discovery-client.js";
import { gatewayKeyPath, loadStagedGatewaySigner, stageGatewayKey } from "./gateway-key.js";
import type { RebindPreparation } from "./rebind-operations.js";
import { reconcileRegistration } from "./registration-recovery.js";
import type { createServiceGatewayKey } from "./service-gateway-key.js";
import type { OpenClawIdStatus } from "./service.js";
import { ed25519PublicKeyHex, loadKeyFile, stagedKeyPath } from "./tunnel-child/keyfile.js";
import { discardStagedEndpointKey, stageEndpointKey } from "./tunnel-runtime.js";

const cancelled = () =>
  refusal(
    "rebind_cancelled",
    "OpenClaw ID stopped or was disabled; start again while it is enabled",
  );

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

const notLocal = () =>
  refusal("not_local_operator", "moving to new keys only works on the computer running this claw");

/** The keys a re-bind moves to; the tunnel child stages K_srv'. */
async function stageKeys(stateDir: string) {
  return { kGw: stageGatewayKey(stateDir), kSrv: await stageEndpointKey(stateDir) };
}

/** A re-bind step, and what commit (the signed binding) and prepare/commit (the code) take. */
export type RebindAction = "prepare" | "commit" | "cancel";
export type RebindInput = { binding?: unknown; code?: string };

/** A persisted move stays successful even if activating or publishing its keys fails. */
export type RebindCommitResult = { ok: true; moved: true; bindingSeq: number } & (
  | { followUpError?: never }
  | { published: null; followUpError: string; nextStep: "openclaw id status" }
);

/** Discovery's published descriptor for the claw (untrusted), or why it could not be read. */
export type PublishedLookup = { descriptor: unknown } | { error: string; detail: string };

type Deps = {
  getStateDir: () => string;
  getConfig: () => GatewayOpenClawIdConfig | undefined;
  getAuthority: () => Promise<OpenClawIdAuthority>;
  gatewayKey: ReturnType<typeof createServiceGatewayKey>;
  /** Restarts remote access, so the tunnel child and K_gw follow the stored binding. */
  restartRemoteAccess: () => Promise<OpenClawIdStatus>;
  /** Keeps the owner account's code in memory for publishing the committed re-bind. */
  holdCode: (code: string | undefined) => void;
  log: { info: (message: string) => void };
};

export function createServiceRebind(deps: Deps) {
  // Settles a registration whose receipt is missing, with the K_gw Discovery knows. A claw
  // Discovery never registered (`not_found`) re-binds freely: it registers later with a code.
  const settledRegistration = async (
    owner: OpenClawIdAuthority,
  ): Promise<AuthorityRefusal | undefined> => {
    if (owner.current()?.discovery.owner_account_id) {
      return undefined;
    }
    const unsettled = refusal(
      "registration_unsettled",
      "Discovery may already have this claw: publish it first (openclaw id publish), then move it to new keys",
    );
    const discoveryUrl = deps.getConfig()?.discoveryUrl;
    const key = await deps.gatewayKey.tryLoad();
    if (!discoveryUrl || !key.ok) {
      return unsettled;
    }
    const client = createDiscoveryClient({ baseUrl: discoveryUrl, signer: key.signer });
    return (await reconcileRegistration(owner, client)) ? unsettled : undefined;
  };

  const linkedOwner = async (channel: Channel | undefined) => {
    if (channel !== "local_operator") {
      return notLocal();
    }
    const owner = await deps.getAuthority();
    if (!owner.current()?.binding) {
      return refusal("not_linked", "this claw is not linked");
    }
    return owner;
  };

  // Discovery's published descriptor, read with the owner's code and the staged K_gw (the
  // current one may be lost). Untrusted: the CLI verifies it with the root from the kit.
  const published = async (clawId: string, code: string | undefined): Promise<PublishedLookup> => {
    const discoveryUrl = deps.getConfig()?.discoveryUrl;
    if (!code || !discoveryUrl) {
      return { error: "no_code", detail: "no link code was given" };
    }
    try {
      const signer = await loadStagedGatewaySigner(deps.getStateDir());
      const client = createDiscoveryClient({ baseUrl: discoveryUrl, signer });
      return { descriptor: (await client.getPublishedDescriptor(clawId, code)).descriptor };
    } catch (error) {
      // SAFETY: code is optional and falls back to "unavailable" when absent.
      const failure = (error as { code?: string }).code ?? "unavailable";
      return { error: failure, detail: error instanceof Error ? error.message : String(error) };
    }
  };

  // Stages the next keys and returns the binding R must sign, with Discovery's published
  // descriptor when the owner's code reads it. Local only.
  const prepare = async (
    channel: Channel | undefined,
    code: string | undefined,
    isCurrent: () => boolean,
  ): Promise<(RebindPreparation & { published: PublishedLookup }) | AuthorityRefusal> => {
    const owner = await linkedOwner(channel);
    if ("ok" in owner) {
      return owner;
    }
    const unsettled = await settledRegistration(owner);
    if (unsettled) {
      return unsettled;
    }
    if (!isCurrent()) {
      return cancelled();
    }
    const keys = await stageKeys(deps.getStateDir());
    if (!isCurrent()) {
      return cancelled();
    }
    const prep = await owner.prepareRebind(keys);
    const result =
      "ok" in prep ? prep : { ...prep, published: await published(prep.claw_id, code) };
    return isCurrent() ? result : cancelled();
  };

  // Stores the R-signed binding for the staged keys, then moves remote access to them.
  const commit = async (
    channel: Channel | undefined,
    binding: unknown,
    code: string | undefined,
    isCurrent: () => boolean,
  ): Promise<RebindCommitResult | AuthorityRefusal> => {
    const owner = await linkedOwner(channel);
    if ("ok" in owner) {
      return owner;
    }
    const unsettled = await settledRegistration(owner);
    if (unsettled) {
      return unsettled;
    }
    if (!isCurrent()) {
      return cancelled();
    }
    const keys = await stageKeys(deps.getStateDir());
    if (!isCurrent()) {
      return cancelled();
    }
    const result = await owner.commitRebind(binding, channel, keys, isCurrent);
    if (!result.ok) {
      return result;
    }
    const committed = { ok: true, moved: true, bindingSeq: result.bindingSeq } as const;
    try {
      deps.log.info(`openclaw-id: moved to new keys (binding ${result.bindingSeq})`);
      deps.holdCode(code);
      // The stored binding's lead over the published sequence already makes publication pending.
      const status = await deps.restartRemoteAccess();
      if (status.state === "failed" || status.state === "keys_refused") {
        throw new Error(status.reason);
      }
      return committed;
    } catch (error) {
      return {
        ...committed,
        published: null,
        followUpError: error instanceof Error ? error.message : String(error),
        nextStep: "openclaw id status",
      };
    }
  };

  // Deletes the staged keys of a re-bind that was not committed. A staged key the stored
  // binding names (committed, not promoted yet) stays. Local only.
  const cancel = async (channel: Channel | undefined): Promise<{ ok: true } | AuthorityRefusal> => {
    const owner = await linkedOwner(channel);
    if ("ok" in owner) {
      return owner;
    }
    const bound = owner.current()?.binding?.body;
    const stateDir = deps.getStateDir();
    const stagedGateway = stagedKeyPath(gatewayKeyPath(stateDir));
    const gatewayKey = loadKeyFile(stagedGateway);
    if (gatewayKey && `ed25519:${ed25519PublicKeyHex(gatewayKey)}` !== bound?.k_gw) {
      fs.rmSync(stagedGateway, { force: true });
    }
    gatewayKey?.fill(0);
    await discardStagedEndpointKey(stateDir, bound?.k_srv ?? "");
    return { ok: true };
  };

  let lane: Promise<unknown> = Promise.resolve();
  return {
    /** Runs one re-bind step after the previous one finished. */
    run(
      action: RebindAction,
      channel: Channel | undefined,
      input: RebindInput,
      isCurrent: () => boolean,
    ) {
      const step = (): Promise<
        RebindPreparation | AuthorityRefusal | RebindCommitResult | { ok: true }
      > =>
        !isCurrent()
          ? Promise.resolve(cancelled())
          : action === "prepare"
            ? prepare(channel, input.code, isCurrent)
            : action === "commit"
              ? commit(channel, input.binding, input.code, isCurrent)
              : cancel(channel);
      const result = lane.then(step, step);
      lane = result.catch(() => {});
      return result;
    },
  };
}

export type ServiceRebind = ReturnType<typeof createServiceRebind>;
