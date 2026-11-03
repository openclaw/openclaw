import { randomUUID } from "node:crypto";
import { expect, it, type Mock } from "vitest";
import { listGitHubDeviceAuthorizationRecords } from "../agents/github-oauth-records.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import { seedAgentProvenance } from "../test-utils/agent-provenance.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import type { LegacyGitHubOAuthService } from "./github-oauth-lifecycle-host.types.js";
import { NOW } from "./github-oauth-lifecycle.test-support.js";

const { resolveConfiguredGitHubToolIdentity } = await loadBundledPluginFacade<{
  resolveConfiguredGitHubToolIdentity(params: {
    config: OpenClawConfig;
    agentId: string;
    scope: "system" | "agent";
  }): { profileId: string } | undefined;
}>({ pluginId: "github-repositories", artifactBasename: "tool-identity-api.js" });

export function registerGitHubOAuthRetirementTests(params: {
  createLifecycle: () => Promise<
    Pick<LegacyGitHubOAuthService, "startAuthorization" | "pollAuthorization" | "stop">
  >;
  replaceIdentity: () => void;
  getConfig: () => OpenClawConfig;
  advanceToPoll: (requestId: string) => Promise<void>;
  mocks: {
    requestDeviceCode: Mock;
    pollDeviceToken: Mock;
    installProfile: Mock;
    updateConfig: Mock;
  };
}) {
  const { createLifecycle, replaceIdentity, getConfig, advanceToPoll, mocks } = params;

  it.each(["identity replacement", "shutdown"] as const)(
    "does not request a device code after %s during agent preparation",
    async (change) => {
      const lifecycle = await createLifecycle();
      const pending = lifecycle.startAuthorization({ scope: "agent", agentId: "main" });
      const rejected = expect(pending).rejects.toThrow();
      if (change === "identity replacement") {
        replaceIdentity();
      } else {
        await lifecycle.stop();
      }

      await rejected;
      expect(mocks.requestDeviceCode).not.toHaveBeenCalled();
      expect(await listGitHubDeviceAuthorizationRecords()).toEqual([]);
    },
  );

  it("rejects an agent authorization after the agent enters deletion", async () => {
    const lifecycle = await createLifecycle();
    const started = await lifecycle.startAuthorization({ scope: "agent", agentId: "main" });
    const deletion = beginAgentDeletionJournal({
      agentId: "main",
      operationId: randomUUID(),
      agentDir: "/agents/main",
      workspaceDir: "/workspaces/main",
      sessionsDir: "/sessions/main",
      deleteFiles: true,
    });
    try {
      await advanceToPoll(started.requestId);

      await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
        status: "failed",
        reason: "identity_changed",
      });
      expect(mocks.pollDeviceToken).not.toHaveBeenCalled();
      expect(mocks.installProfile).not.toHaveBeenCalled();
    } finally {
      removeAgentDeletionJournal(deletion.agentId, deletion.operationId);
    }
  });

  it("rejects an agent authorization after same-id recreation gets fresh provenance", async () => {
    const lifecycle = await createLifecycle();
    const started = await lifecycle.startAuthorization({ scope: "agent", agentId: "main" });
    seedAgentProvenance("main", { createdVia: "operator" }, { nowMs: NOW + 1 });
    await advanceToPoll(started.requestId);

    await expect(lifecycle.pollAuthorization(started.requestId)).resolves.toEqual({
      status: "failed",
      reason: "identity_changed",
    });
    expect(mocks.installProfile).not.toHaveBeenCalled();
    expect(mocks.updateConfig).not.toHaveBeenCalled();
    expect(
      resolveConfiguredGitHubToolIdentity({
        config: getConfig(),
        scope: "agent",
        agentId: "main",
      }),
    ).toBeUndefined();
  });
}
