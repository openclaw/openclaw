import { TEMPLATE_BOOTSTRAP_FILE_NAMES } from "../../../../src/templates/manifest-contract.js";
import type { IconName } from "../../components/solid/icon.tsx";

// Match workspace destinations, never package-source basenames.
export const agentDocuments = new Set<string>([
  ...TEMPLATE_BOOTSTRAP_FILE_NAMES,
  "BOOTSTRAP.md",
  "USER.md",
  "MEMORY.md",
]);

// Workspace roles use exact root-relative names; nested lookalikes are ordinary files.
const fileRoles = new Map<string, readonly [IconName, string]>([
  ["AGENTS.md", ["botText", "agents"]],
  ["SOUL.md", ["drama", "soul"]],
  ["USER.md", ["circleUser", "user"]],
  ["IDENTITY.md", ["bot", "identity"]],
  ["BOOTSTRAP.md", ["rocket", "bootstrap"]],
  ["MEMORY.md", ["brain", "memory"]],
  ["TOOLS.md", ["wrench", "tools"]],
  ["HEARTBEAT.md", ["activity", "heartbeat"]],
]);

export function fileRole(name: string): readonly [IconName, string] {
  return fileRoles.get(name) ?? ["fileText", "generic"];
}
