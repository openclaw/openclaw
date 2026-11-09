import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  mutateConfigFileWithRetry: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));

import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";

describe("GitHub identity config mutation", () => {
  it.each([undefined, false, true])(
    "preserves sandbox opt-in %s across replacement and removes it on inherit",
    async (allowInSandbox) => {
      const sandboxPolicy = allowInSandbox === undefined ? {} : { allowInSandbox };
      const previousIdentity = { profileId: `ghp_${"1".repeat(32)}`, ...sandboxPolicy };
      const nextIdentity = { profileId: `ghp_${"2".repeat(32)}`, kind: "oauth" as const };
      const draft: OpenClawConfig = {
        agents: { entries: { main: { tools: { github: previousIdentity } } } },
      };
      mocks.mutateConfigFileWithRetry.mockImplementation(async ({ mutate }) => {
        await mutate(draft);
        return { nextConfig: draft };
      });

      await updateGitHubToolIdentityConfig({
        scope: "agent",
        agentId: "main",
        identity: nextIdentity,
        expectedIdentity: previousIdentity,
      });
      expect(draft.agents?.entries?.main?.tools?.github).toStrictEqual({
        ...nextIdentity,
        ...sandboxPolicy,
      });

      await updateGitHubToolIdentityConfig({
        scope: "agent",
        agentId: "main",
        expectedIdentity: { ...nextIdentity, ...sandboxPolicy },
      });
      expect(draft.agents?.entries?.main?.tools?.github).toBeUndefined();
    },
  );
});
