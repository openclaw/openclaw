/** How an original-state capture acquires its database reads; a leaf shared by the capture and backup owners. */
export type UpdateRecoveryCaptureAcquisition =
  | { mode: "isolated-steps" }
  | { mode: "maintenance-owner" };
