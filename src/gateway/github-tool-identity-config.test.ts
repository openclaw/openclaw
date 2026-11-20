import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  mutateConfigFileWithRetry: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  mutateConfigFileWithRetry: mocks.mutateConfigFileWithRetry,
}));

import { updateGitHubToolIdentityConfig } from "./github-tool-identity-config.js";

beforeEach(() => vi.clearAllMocks());

describe("GitHub identity config mutation", () => {
  it.each(["commit", "path conflict", "write failure"] as const)(
    "publishes agent identity and execution path together: %s",
    async (outcome) => {
      const previousIdentity = { profileId: `ghp_${"1".repeat(32)}` };
      const nextIdentity = {
        profileId: `ghp_${"2".repeat(32)}`,
        kind: "oauth" as const,
        gitAuthor: { name: "octocat", email: "1+octocat@users.noreply.github.com" },
      };
      const retained: OpenClawConfig = {
        tools: { github: previousIdentity, exec: { pathPrepend: ["/shared/bin"] } },
        agents: {
          entries: {
            main: { tools: { github: previousIdentity, exec: { pathPrepend: ["/old/bin"] } } },
            sibling: { tools: { github: previousIdentity } },
          },
        },
      };
      let published = retained;
      mocks.mutateConfigFileWithRetry.mockImplementation(async ({ mutate }) => {
        const draft = structuredClone(published);
        await mutate(draft);
        if (outcome === "write failure") {
          throw new Error("write failed");
        }
        published = draft;
        return { nextConfig: draft };
      });
      const activation = updateGitHubToolIdentityConfig({
        scope: "agent",
        agentId: "main",
        identity: nextIdentity,
        expectedIdentity: previousIdentity,
        pathPrepend: {
          expected: outcome === "path conflict" ? null : ["/old/bin"],
          value: ["/agent/bin"],
        },
      });
      if (outcome !== "commit") {
        await expect(activation).rejects.toThrow(
          outcome === "path conflict" ? "execution path changed" : "write failed",
        );
        expect(published).toBe(retained);
      } else {
        await activation;
        expect(published.agents?.entries?.main?.tools).toEqual({
          github: nextIdentity,
          exec: { pathPrepend: ["/agent/bin"] },
        });
        expect(published.tools).toEqual(retained.tools);
        expect(published.agents?.entries?.sibling).toEqual(retained.agents?.entries?.sibling);
      }
      expect(mocks.mutateConfigFileWithRetry).toHaveBeenCalledTimes(1);
      expect(retained.agents?.entries?.main?.tools).toEqual({
        github: previousIdentity,
        exec: { pathPrepend: ["/old/bin"] },
      });
    },
  );

  it("refuses an execution path activation on the System identity", async () => {
    await expect(
      updateGitHubToolIdentityConfig({
        scope: "system",
        agentId: "main",
        identity: { profileId: `ghp_${"1".repeat(32)}` },
        pathPrepend: { expected: null, value: ["/agent/bin"] },
      }),
    ).rejects.toThrow("requires an agent identity");
    expect(mocks.mutateConfigFileWithRetry).not.toHaveBeenCalled();
  });

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
