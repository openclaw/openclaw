export type ObaBlock = {
  owner: string; // JWKS URL
  kid: string; // key id
  alg: "EdDSA"; // Ed25519 only
  sig: string; // base64url signature
};

export type ObaVerificationResult = {
  status: "unsigned" | "signed" | "verified" | "invalid";
  ownerUrl?: string;
  reason?: string;
};
