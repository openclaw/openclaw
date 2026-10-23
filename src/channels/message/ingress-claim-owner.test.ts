import { describe, expect, it, vi } from "vitest";
import {
  INGRESS_CLAIM_LEASE_MS,
  INGRESS_CLAIM_PROCESS_ID,
  isIngressClaimOwnedByOtherLiveProcess,
  isIngressCorruptClaimOwnedByOtherLiveProcess,
  processPidFromOwnerId,
} from "./ingress-claim-owner.js";

const claim = (ownerId: string, claimedAt = Date.now()) => ({
  claim: { ownerId, token: "test-auth-token", claimedAt },
});
const liveOwnerPid = process.ppid > 0 ? process.ppid : 1;

describe("ingress claim owner", () => {
  it("parses process pid from owner id", () => {
    expect(processPidFromOwnerId("4242:1000:dead-owner")).toBe(4242);
    expect(processPidFromOwnerId("not-a-pid:x:uuid")).toBe(-1);
    expect(processPidFromOwnerId("")).toBe(-1);
  });

  it("does not treat stale claims with reused pids as live-owned", () => {
    expect(
      isIngressClaimOwnedByOtherLiveProcess(
        claim(`${process.pid}:1:other-process`, Date.now() - INGRESS_CLAIM_LEASE_MS - 1),
      ),
    ).toBe(false);
  });

  it("does not treat a fresh foreign claim as live-owned when its pid is only a thread of this process", () => {
    // Incident shape: dead owner PID 9 is reused as a Linux TID of the new process.
    // process.kill(9, 0) succeeds, but starttime no longer matches the claim owner.
    using kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(
      isIngressClaimOwnedByOtherLiveProcess(claim("9:1000:dead-owner"), {
        readProcessStartTime: (pid) => (pid === 9 ? 2000 : null),
      }),
    ).toBe(false);
    expect(kill).toHaveBeenCalledWith(9, 0);
  });

  it("treats fresh claims with other live process instances as live-owned", () => {
    using kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(
      isIngressClaimOwnedByOtherLiveProcess(claim(`${liveOwnerPid}:5555:other-process`), {
        readProcessStartTime: (pid) => (pid === liveOwnerPid ? 5555 : null),
      }),
    ).toBe(true);
    expect(kill).toHaveBeenCalledWith(liveOwnerPid, 0);
  });

  it("keeps existence-based lease protection for fresh legacy two-part owner ids", () => {
    // Rolling upgrade: a live pre-starttime worker still holds pid:uuid claims.
    // Stealing them while the owner process exists would double-dispatch.
    using kill = vi.spyOn(process, "kill").mockReturnValue(true);
    expect(
      isIngressClaimOwnedByOtherLiveProcess(claim(`${liveOwnerPid}:legacy-owner`), {
        readProcessStartTime: () => 1,
      }),
    ).toBe(true);
    expect(kill).toHaveBeenCalledWith(liveOwnerPid, 0);
  });

  it("treats fresh corrupt claims owned by this process as still live", () => {
    expect(
      isIngressCorruptClaimOwnedByOtherLiveProcess({
        id: "e1",
        channelId: "test",
        accountId: "default",
        queueName: "q",
        reason: "corrupt_payload",
        ...claim(INGRESS_CLAIM_PROCESS_ID),
      }),
    ).toBe(true);
  });
});
