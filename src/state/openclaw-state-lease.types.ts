export type OpenClawStateLeaseIdentity = { scope: string; key: string; owner: string };
type OpenClawStateLeaseHolder = {
  owner: string;
  epoch: number;
  expiresAt: number | null;
  description?: string;
  queued?: true;
};
export type OpenClawStateLeaseAcquisition =
  | { kind: "acquired"; expiresAt: number }
  | { kind: "held"; holder: OpenClawStateLeaseHolder };
