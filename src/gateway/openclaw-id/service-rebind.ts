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
import fs from "node:fs";
import type { Channel } from "../../../packages/openclaw-id-protocol/src/index.js";
import type { AuthorityRefusal } from "./authority-result.js";
import type { OpenClawIdAuthority } from "./authority.js";
import { gatewayKeyPath, stageGatewayKey } from "./gateway-key.js";
import type { RebindPreparation } from "./rebind-operations.js";
import { ed25519PublicKeyHex, loadKeyFile, stagedKeyPath } from "./tunnel-child/keyfile.js";
import { discardStagedEndpointKey, stageEndpointKey } from "./tunnel-runtime.js";

const refusal = (code: string, detail: string): AuthorityRefusal => ({ ok: false, code, detail });

const notLocal = () =>
  refusal("not_local_operator", "moving to new keys only works on the computer running this claw");

/** The keys a re-bind moves to; the tunnel child stages K_srv'. */
async function stageKeys(stateDir: string) {
  return { kGw: stageGatewayKey(stateDir), kSrv: await stageEndpointKey(stateDir) };
}

export function createServiceRebind(deps: {
  getStateDir: () => string;
  getAuthority: () => Promise<OpenClawIdAuthority>;
  /** Restarts remote access, so the tunnel child and K_gw follow the stored binding. */
  restartRemoteAccess: () => Promise<void>;
  log: { info: (message: string) => void };
}) {
  return {
    /** Stages the next keys and returns the binding R must sign. Local only. */
    async prepare(channel: Channel | undefined): Promise<RebindPreparation | AuthorityRefusal> {
      if (channel !== "local_operator") {
        return notLocal();
      }
      const owner = await deps.getAuthority();
      if (!owner.current()?.binding) {
        return refusal("not_linked", "this claw is not linked");
      }
      return await owner.prepareRebind(await stageKeys(deps.getStateDir()));
    },

    /** Stores the R-signed binding for the staged keys, then moves remote access to them. */
    async commit(
      channel: Channel | undefined,
      binding: unknown,
    ): Promise<{ ok: true; bindingSeq: number } | AuthorityRefusal> {
      if (channel !== "local_operator") {
        return notLocal();
      }
      const owner = await deps.getAuthority();
      if (!owner.current()?.binding) {
        return refusal("not_linked", "this claw is not linked");
      }
      const result = await owner.commitRebind(
        binding,
        channel,
        await stageKeys(deps.getStateDir()),
      );
      if (!result.ok) {
        return result;
      }
      deps.log.info(`openclaw-id: moved to new keys (binding ${result.bindingSeq})`);
      // Durable before the restart: if publishing does not finish now, it runs at the next start.
      await owner.recordDiscovery({ publish_pending: true });
      await deps.restartRemoteAccess();
      return { ok: true, bindingSeq: result.bindingSeq };
    },

    /**
     * Deletes the staged keys of a re-bind that was not committed. A staged key the stored
     * binding names (committed, not promoted yet) stays. Local only.
     */
    async cancel(channel: Channel | undefined): Promise<{ ok: true } | AuthorityRefusal> {
      if (channel !== "local_operator") {
        return notLocal();
      }
      const bound = (await deps.getAuthority()).current()?.binding?.body;
      const stateDir = deps.getStateDir();
      const stagedGateway = stagedKeyPath(gatewayKeyPath(stateDir));
      const gatewayKey = loadKeyFile(stagedGateway);
      if (gatewayKey && `ed25519:${ed25519PublicKeyHex(gatewayKey)}` !== bound?.k_gw) {
        fs.rmSync(stagedGateway, { force: true });
      }
      gatewayKey?.fill(0);
      await discardStagedEndpointKey(stateDir, bound?.k_srv ?? "");
      return { ok: true };
    },
  };
}
