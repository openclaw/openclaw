/** Exact owner-approved association; it is not a credential or new identity proof. */
export type OperatorProfileEnrollment = {
  deviceId: string;
  publicKey: string;
  createdAtMs: number;
  profileId: string;
};
