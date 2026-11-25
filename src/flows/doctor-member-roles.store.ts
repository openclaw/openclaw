import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { operatorRoleSubject } from "../gateway/operator-role-enforcement.js";
import { resolveOperatorRoleSelection } from "../gateway/operator-role-policy.js";
import { prepareCorePluginStateReplacement } from "../plugin-state/plugin-state-store.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { readOpenClawIdUserProfiles } from "../state/user-profile-openclaw-id.js";

/** Read raw stored membership for Doctor without normalizing or writing any claw rows. */
export async function readDoctorMemberRoles(
  cfg: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
): Promise<Map<string, string>> {
  const rows = await prepareCorePluginStateReplacement<unknown>({
    ownerId: "core:openclaw-id",
    namespace: "claw",
    retention: "retained",
    env,
  }).entries();
  const members = new Map<string, string>();
  if (rows.length === 0) {
    return members;
  }
  const entries = new Map(rows.map(({ key, value }) => [key, value]));
  const record = entries.get("current");
  if (!isRecord(record) || (record.v !== 1 && record.v !== 2)) {
    throw new Error("Invalid OpenClaw ID claw record");
  }
  if (record.v === 2) {
    const required = ["invite-reports", "member-approvals", "token-bindings"];
    if (record.authority !== null) {
      required.push("owner-devices", "members", "invites");
    }
    if (required.some((key) => !entries.has(key))) {
      throw new Error("Incomplete OpenClaw ID claw record");
    }
  }
  if (record.authority === null) {
    return members;
  }
  if (!isRecord(record.authority)) {
    throw new Error("Invalid OpenClaw ID authority");
  }
  const chunks =
    record.v === 1
      ? [record.authority.members]
      : rows
          .filter(({ key }) => key === "members" || key.startsWith("members:"))
          .map(({ value }) => value);
  for (const chunk of chunks) {
    if (!isRecord(chunk)) {
      throw new Error("OpenClaw ID claw storage has an invalid member collection");
    }
    for (const [accountId, member] of Object.entries(chunk)) {
      if (!isRecord(member) || typeof member.role !== "string") {
        throw new Error("Invalid OpenClaw ID member role");
      }
      members.set(accountId, member.role);
    }
  }
  const profiles = await readOpenClawIdUserProfiles([...members.keys()], { env });
  const snapshot = await executeExistingOpenClawStateRead(
    { env },
    { type: "userProfiles.catalog" },
  );
  const catalog = new Map(snapshot?.profiles ?? []);
  const initialized = isRecord(record.member_profile_roles) ? record.member_profile_roles : {};
  for (const [accountId, label] of members) {
    const profile = catalog.get(profiles[accountId]?.id ?? "");
    // Offline upgrades preview the one-time import without writing either store.
    const assigned = profile?.role ?? (initialized[accountId] ? null : label);
    const selected = resolveOperatorRoleSelection(
      profile?.id ?? accountId,
      assigned,
      cfg,
      profile?.githubLogin ?? null,
      operatorRoleSubject(profile),
    );
    members.set(accountId, selected.effectiveRole ?? assigned ?? "unassigned");
  }
  return members;
}
