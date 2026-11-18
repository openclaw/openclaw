import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { prepareCorePluginStateReplacement } from "../plugin-state/plugin-state-store.js";

/** Read raw stored membership for Doctor without normalizing or writing any claw rows. */
export async function readDoctorMemberRoles(env?: NodeJS.ProcessEnv): Promise<Map<string, string>> {
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
  return members;
}
