// Verifies channels whose runtime resolves supplemental context visibility accept the key.
import { describe, expect, it } from "vitest";
import { validateConfigObjectWithPlugins } from "../../config/validation.js";

/**
 * Channels whose own runtime calls resolveChannelContextVisibilityMode, so the
 * documented per-channel override in docs/channels/groups.md must validate.
 * Rejecting it refuses the whole config, not just the key.
 */
const CONTEXT_VISIBILITY_CHANNELS = ["feishu", "mattermost"] as const;

async function validationIssuesFor(channelId: string): Promise<string[]> {
  const result = await validateConfigObjectWithPlugins(
    { channels: { [channelId]: { contextVisibility: "allowlist" } } },
    { pluginValidation: "full" },
  );
  return (result?.issues ?? []).map((issue) => `${issue.path ?? ""}: ${issue.message ?? ""}`);
}

describe("channel contextVisibility contract", () => {
  it.each(CONTEXT_VISIBILITY_CHANNELS)(
    "%s accepts channels.<id>.contextVisibility",
    async (channelId) => {
      const issues = await validationIssuesFor(channelId);
      expect(issues.filter((issue) => issue.includes("contextVisibility"))).toEqual([]);
    },
  );
});
