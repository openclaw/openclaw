import { afterEach, expect, it, vi } from "vitest";
import { withTempHome } from "../../config/home-env.test-harness.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { invokePluginArtifactInstallMock } from "../../plugins/test-helpers/install-fixtures.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import {
  clawHubInstallResult,
  committedPluginMetadata,
} from "./commands-plugins.install.test-support.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const mocks = vi.hoisted(() => ({
  archive: vi.fn(),
  npm: vi.fn(),
  path: vi.fn(),
  hub: vi.fn(),
  git: vi.fn(),
  persist: vi.fn(),
}));

vi.mock("../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install.js")>()),
  installPluginFromNpmPackArchive: mocks.archive,
  installPluginFromNpmSpec: invokePluginArtifactInstallMock.bind(null, mocks.npm),
  installPluginFromPath: mocks.path,
}));

vi.mock("../../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/clawhub.js")>()),
  installPluginFromClawHub: invokePluginArtifactInstallMock.bind(null, mocks.hub),
}));

vi.mock("../../plugins/git-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/git-install.js")>()),
  installPluginFromGitSpec: mocks.git,
}));

vi.mock("../../plugins/install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install-persistence.js")>()),
  persistPluginInstall: mocks.persist,
}));

vi.mock("../../plugins/official-external-plugin-catalog.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/official-external-plugin-catalog.js")>()),
  loadConfiguredHostedOfficialExternalPluginCatalogEntries: async () => ({
    source: "hosted",
    entries: [],
  }),
}));
vi.mock("../../plugins/management-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/management-service.js")>()),
  refreshManagedPluginMetadata: () => committedPluginMetadata(mocks.persist.mock.lastCall?.[0]),
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-plugins-clawhub-");

function runClawHubCommand(commandBodyNormalized: string, workspaceDir: string) {
  return handlePluginsCommand(
    buildPluginsCommandParams({
      commandBodyNormalized,
      workspaceDir,
      gatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
    }),
    true,
  );
}

function expectNoInstallEffects() {
  for (const mock of [mocks.archive, mocks.npm, mocks.path, mocks.hub, mocks.git, mocks.persist]) {
    expect(mock).not.toHaveBeenCalled();
  }
}

afterEach(async () => {
  Object.values(mocks).forEach((mock) => mock.mockReset());
  await workspaceHarness.cleanupWorkspaces();
});

it.each([false, true])(
  "keeps chat installation on its admitted Gateway (retired=%s)",
  async (retired) => {
    const application = { operationId: "chat-install", generation: 9, pluginIds: ["demo"] };
    const applyRuntime = vi.fn(async () => application);
    let current = true;
    const context: Partial<GatewayRequestContext> = { applyPluginLifecycleChange: applyRuntime };
    mocks.hub.mockImplementation(async () => {
      await Promise.resolve();
      current = !retired;
      return clawHubInstallResult("demo", "community/demo");
    });
    mocks.persist.mockImplementation(async (params) => {
      params.beforePersistentApply?.();
      await params.applyRuntime?.({
        config: params.snapshot.config,
        pluginIds: ["demo"],
        reason: "install",
      });
      return params.snapshot.config;
    });
    await withTempHome("openclaw-command-plugins-owner-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const result = withPluginRuntimeGatewayRequestScope(
        {
          resolveGatewayContext: () => (current ? (context as GatewayRequestContext) : undefined),
          isWebchatConnect: () => false,
        },
        () =>
          runClawHubCommand("/plugins install community/demo --accept-capabilities", workspaceDir),
      );
      if (retired) {
        await expect(result).rejects.toThrow("Gateway that admitted this command");
        expect(applyRuntime).not.toHaveBeenCalled();
      } else {
        expect((await result)?.reply?.text).toContain("Applied in Gateway generation 9.");
        expect(applyRuntime).toHaveBeenCalledOnce();
      }
    });
  },
);

it.each(["clawhub:", "clawhub:demo@"])(
  "rejects malformed source %s before installer side effects",
  async (raw) => {
    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const result = await runClawHubCommand(`/plugins install ${raw} --force`, workspaceDir);

      expect(result?.shouldContinue).toBe(false);
      expect(result?.reply?.text).toContain(`Unsupported ClawHub plugin spec: ${raw}`);
      expectNoInstallEffects();
    });
  },
);

it("requires capability consent and names the declared capabilities before installing", async () => {
  mocks.hub.mockResolvedValue(clawHubInstallResult("clawhub-demo", "@openclaw/clawhub-demo", true));

  await withTempHome("openclaw-command-plugins-home-", async () => {
    const workspaceDir = await workspaceHarness.createWorkspace();
    const result = await runClawHubCommand(
      "/plugins install clawhub:@openclaw/clawhub-demo@1.2.3",
      workspaceDir,
    );

    expect(result?.shouldContinue).toBe(false);
    expect(result?.reply?.text).toBe(
      [
        "⚠️ Plugin capabilities require approval: Cold Control Plane (clawhub-demo) @ 1.2.3",
        "Source: clawhub: clawhub:@openclaw/clawhub-demo@1.2.3",
        "Channels: cold-channel",
        "Providers: cold-model-provider",
        "Prompt injection: allowed",
        "Conversation access: denied",
        "Review these capabilities, then rerun /plugins install clawhub:@openclaw/clawhub-demo@1.2.3 --accept-capabilities to continue.",
      ].join("\n"),
    );
    expect(mocks.persist).not.toHaveBeenCalled();
  });
});
