import type * as kernel from "./ingress-queue.kernel.js";
import type { ChannelIngressListInput, ChannelIngressRow } from "./ingress-queue.types.js";

type Operation<Fn extends (...args: never[]) => unknown> = {
  input: Parameters<Fn>[1];
  output: ReturnType<Fn>;
};

type ClaimOperation<Fn extends (...args: never[]) => unknown> = {
  input: Parameters<Fn>[1] & { customClock?: true };
  output: ReturnType<Fn>;
};

export type ChannelIngressWorkerOperations = {
  "channelIngress.list": {
    input: ChannelIngressListInput & { readOnly: boolean };
    output: ChannelIngressRow[];
  };
  "channelIngress.claimSnapshot": Operation<
    typeof kernel.readChannelIngressClaimSnapshotInDatabase
  >;
  "channelIngress.staleClaims": Operation<typeof kernel.listStaleChannelIngressClaimsInDatabase>;
  "channelIngress.enqueue": Operation<typeof kernel.enqueueChannelIngressInDatabase>;
  "channelIngress.claim": ClaimOperation<typeof kernel.claimChannelIngressInDatabase>;
  "channelIngress.claimNext": ClaimOperation<typeof kernel.claimNextChannelIngressInDatabase>;
  "channelIngress.recover": Operation<typeof kernel.recoverChannelIngressClaimInDatabase>;
  "channelIngress.refresh": Operation<typeof kernel.refreshChannelIngressClaimInDatabase>;
  "channelIngress.complete": Operation<typeof kernel.completeChannelIngressInDatabase>;
  "channelIngress.release": Operation<typeof kernel.releaseChannelIngressInDatabase>;
  "channelIngress.fail": Operation<typeof kernel.failChannelIngressInDatabase>;
  "channelIngress.delete": Operation<typeof kernel.deleteChannelIngressInDatabase>;
  "channelIngress.resubmit": Operation<typeof kernel.resubmitChannelIngressInDatabase>;
  "channelIngress.prune": Operation<typeof kernel.pruneChannelIngressInDatabase>;
  "channelIngress.purge": Operation<typeof kernel.purgeChannelIngressInDatabase>;
};
