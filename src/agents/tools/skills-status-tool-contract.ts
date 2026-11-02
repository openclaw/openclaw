// Status discovery refreshes file-backed inventory and can be slow on cold caches.
export const SKILLS_STATUS_TIMEOUT_MS = 60_000;

export const SKILLS_STATUS_TOOL_DESCRIPTION =
  "Read the installed skill inventory and why each skill is or is not usable: eligible, disabled, " +
  "blocked by the agent allowlist, platform-incompatible, or missing required programs or config. " +
  "Use this to answer why a skill is unavailable and what would make it available. " +
  "refresh re-scans the file-backed inventory after a local change. " +
  "This is a current snapshot; it never installs, enables, or modifies any skill.";
