/** Owner-visible evidence; no signing material and no authority to approve another browser. */
export type MemberRecoveryUse = {
  seq: number;
  accountId: string;
  memberName: string;
  deviceLabel: string;
  peerKey: string;
  peerFp: string;
  usedAt: number;
};
