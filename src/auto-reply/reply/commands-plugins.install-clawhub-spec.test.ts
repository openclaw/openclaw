// ClawHub chat installs validate selectors, capability consent, and trust boundaries.
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTempHome } from "../../config/home-env.test-harness.js";
import type { GatewayRequestContext } from "../../gateway/server-methods/types.js";
import { withPluginRuntimeGatewayRequestScope } from "../../plugins/runtime/gateway-request-scope.js";
import { invokePluginArtifactInstallMock } from "../../plugins/test-helpers/install-fixtures.js";
import { createCommandWorkspaceHarness } from "./commands-filesystem.test-support.js";
import { committedPluginMetadata } from "./commands-plugins.install.test-support.js";
import { handlePluginsCommand } from "./commands-plugins.js";
import { buildPluginsCommandParams } from "./commands.test-harness.js";

const {
  installPluginFromNpmPackArchiveMock,
  installPluginFromNpmSpecMock,
  installPluginFromPathMock,
  installPluginFromClawHubMock,
  installPluginFromGitSpecMock,
  persistPluginInstallMock,
} = vi.hoisted(() => ({
  installPluginFromNpmPackArchiveMock: vi.fn(),
  installPluginFromNpmSpecMock: vi.fn(),
  installPluginFromPathMock: vi.fn(),
  installPluginFromClawHubMock: vi.fn(),
  installPluginFromGitSpecMock: vi.fn(),
  persistPluginInstallMock: vi.fn(),
}));

vi.mock("../../plugins/install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install.js")>()),
  installPluginFromNpmPackArchive: installPluginFromNpmPackArchiveMock,
  installPluginFromNpmSpec: invokePluginArtifactInstallMock.bind(
    null,
    installPluginFromNpmSpecMock,
  ),
  installPluginFromPath: installPluginFromPathMock,
}));

vi.mock("../../plugins/clawhub.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/clawhub.js")>()),
  installPluginFromClawHub: invokePluginArtifactInstallMock.bind(
    null,
    installPluginFromClawHubMock,
  ),
}));

vi.mock("../../plugins/git-install.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/git-install.js")>()),
  installPluginFromGitSpec: installPluginFromGitSpecMock,
}));

vi.mock("../../plugins/install-persistence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../plugins/install-persistence.js")>()),
  persistPluginInstall: persistPluginInstallMock,
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
  refreshManagedPluginMetadata: () =>
    committedPluginMetadata(persistPluginInstallMock.mock.lastCall?.[0]),
}));

const workspaceHarness = createCommandWorkspaceHarness("openclaw-command-plugins-clawhub-");

function buildClawHubPluginsParams(commandBodyNormalized: string, workspaceDir: string) {
  return buildPluginsCommandParams({
    commandBodyNormalized,
    workspaceDir,
    gatewayClientScopes: ["operator.admin", "operator.write", "operator.pairing"],
  });
}

describe("chat plugin install explicit ClawHub selectors", () => {
  afterEach(async () => {
    installPluginFromNpmPackArchiveMock.mockReset();
    installPluginFromNpmSpecMock.mockReset();
    installPluginFromPathMock.mockReset();
    installPluginFromClawHubMock.mockReset();
    installPluginFromGitSpecMock.mockReset();
    persistPluginInstallMock.mockReset();
    await workspaceHarness.cleanupWorkspaces();
  });

  it.each([false, true])(
    "keeps chat installation on its admitted Gateway (retired=%s)",
    async (retired) => {
      const application = { operationId: "chat-install", generation: 9, pluginIds: ["demo"] };
      const applyRuntime = vi.fn(async () => application);
      let current = true;
      const context: Partial<GatewayRequestContext> = { applyPluginLifecycleChange: applyRuntime };
      installPluginFromClawHubMock.mockImplementation(async () => {
        await Promise.resolve();
        current = !retired;
        return {
          ok: true,
          pluginId: "demo",
          targetDir: "/tmp/demo",
          version: "1.2.3",
          clawhub: {
            source: "clawhub",
            clawhubUrl: "https://clawhub.ai",
            clawhubPackage: "community/demo",
            clawhubFamily: "code-plugin",
            version: "1.2.3",
          },
        };
      });
      persistPluginInstallMock.mockImplementation(async (params) => {
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
            handlePluginsCommand(
              buildClawHubPluginsParams(
                "/plugins install clawhub:community/demo --accept-capabilities",
                workspaceDir,
              ),
              true,
            ),
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
        const params = buildClawHubPluginsParams(`/plugins install ${raw} --force`, workspaceDir);

        const result = await handlePluginsCommand(params, true);

        expect(result?.shouldContinue).toBe(false);
        expect(result?.reply?.text).toContain(`Unsupported ClawHub plugin spec: ${raw}`);
        expect(installPluginFromNpmPackArchiveMock).not.toHaveBeenCalled();
        expect(installPluginFromNpmSpecMock).not.toHaveBeenCalled();
        expect(installPluginFromPathMock).not.toHaveBeenCalled();
        expect(installPluginFromClawHubMock).not.toHaveBeenCalled();
        expect(installPluginFromGitSpecMock).not.toHaveBeenCalled();
        expect(persistPluginInstallMock).not.toHaveBeenCalled();
      });
    },
  );

  it("requires capability consent and names the declared capabilities before installing", async () => {
    installPluginFromClawHubMock.mockResolvedValue({
      ok: true,
      pluginId: "clawhub-demo",
      targetDir: "/tmp/clawhub-demo",
      version: "1.2.3",
      extensions: ["index.js"],
      packageName: "@openclaw/clawhub-demo",
      clawhub: {
        source: "clawhub",
        clawhubUrl: "https://clawhub.ai",
        clawhubPackage: "@openclaw/clawhub-demo",
        clawhubFamily: "code-plugin",
        clawhubChannel: "official",
        version: "1.2.3",
        integrity: "sha512-demo",
        resolvedAt: "2026-03-22T12:00:00.000Z",
      },
    });

    await withTempHome("openclaw-command-plugins-home-", async () => {
      const workspaceDir = await workspaceHarness.createWorkspace();
      const result = await handlePluginsCommand(
        buildClawHubPluginsParams(
          "/plugins install clawhub:@openclaw/clawhub-demo@1.2.3",
          workspaceDir,
        ),
        true,
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
      expect(persistPluginInstallMock).not.toHaveBeenCalled();
    });
  });
});
