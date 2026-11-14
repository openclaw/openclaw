import { describe, expect, it } from "vitest";
import { isCronScratchEffectivelyEmpty } from "./scratch-contract.js";

const legacyHeartbeatScratch = `\`\`\`markdown
# Keep this file empty (or with only comments) to skip heartbeat API calls.

# Add tasks below when you want the agent to check something periodically.
\`\`\`

## Related

- [Heartbeat config](/gateway/config-agents)
`;

describe("isCronScratchEffectivelyEmpty", () => {
  it("keeps edits and unrelated local links actionable", () => {
    expect(isCronScratchEffectivelyEmpty(`${legacyHeartbeatScratch}- Check email\n`)).toBe(false);
    expect(isCronScratchEffectivelyEmpty("- [Review the runbook](/ops/runbook)")).toBe(false);
  });
});
