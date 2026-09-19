import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isProfileDisplayRow } from "./user-profile-list.js";
import type { ProfileDisplayRow } from "./user-profiles.types.js";

type UserProfileRoleRequester = {
  profileId: string | null;
  assignedRole: string | null;
};

export type UserProfileRoleMutationGuard =
  | { family: "native-compatibility"; assertCurrent: () => void }
  | {
      family: "worker";
      requesterReference: string | null;
      assertCurrent: () => void;
      assertRequester: (facts: UserProfileRoleRequester) => void;
    };

export type UserProfileRoleAdmission = {
  kind: "profile-role";
  before?: ProfileDisplayRow;
  requester: UserProfileRoleRequester;
};

export function isUserProfileRoleAdmission(value: unknown): value is UserProfileRoleAdmission {
  return (
    isRecord(value) &&
    value.kind === "profile-role" &&
    (value.before === undefined || isProfileDisplayRow(value.before)) &&
    isRecord(value.requester) &&
    (value.requester.profileId === null || typeof value.requester.profileId === "string") &&
    (value.requester.assignedRole === null || typeof value.requester.assignedRole === "string")
  );
}
