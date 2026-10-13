import type {
  ProfileAuthorityDescriptor,
  ProfileAuthorityStatus,
} from "../state/user-profile-authority.js";

/** Profile checks alone do not grant a native write or replace the final host COMMIT guard. */
export type SqliteProfileAdmissionRequest = {
  kind: "assert-bound-revision" | "read-current-settled-facts";
  authority: ProfileAuthorityDescriptor;
};
export type SqliteProfileAdmissionResult = ProfileAuthorityStatus;
