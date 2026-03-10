import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const loadConfigMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const installNpmAotuiPackageMock = vi.hoisted(() => vi.fn());
const cleanupManagedAotuiAppArtifactsMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  loadConfig: loadConfigMock,
  writeConfigFile: writeConfigFileMock,
}));

vi.mock("../agent-apps/install.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../agent-apps/install.js")>();
  return {
    ...actual,
    installNpmAotuiPackage: installNpmAotuiPackageMock,
    cleanupManagedAotuiAppArtifacts: cleanupManagedAotuiAppArtifactsMock,
  };
});

import {
  agentsAppsListCommand,
  agentsAppsDisableCommand,
  agentsAppsEnableCommand,
  agentsAppsInstallCommand,
  agentsAppsUninstallCommand,
} from "./agents.apps.js";

const runtime = createTestRuntime();

describe("agents apps commands", () => {
  beforeEach(() => {
    loadConfigMock.mockReset();
    writeConfigFileMock.mockClear();
    installNpmAotuiPackageMock.mockReset();
    cleanupManagedAotuiAppArtifactsMock.mockReset();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it("enables Agent Apps globally", async () => {
    loadConfigMock.mockReturnValue({});

    await agentsAppsEnableCommand({}, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      apps: { enabled: true },
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Enabled Agent Apps. Restart the gateway to apply the change.",
    );
  });

  it("disables Agent Apps globally", async () => {
    loadConfigMock.mockReturnValue({});

    await agentsAppsDisableCommand({}, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      apps: { enabled: false },
    });
  });

  it("lists installed Agent Apps", async () => {
    loadConfigMock.mockReturnValue({
      apps: {
        registry: {
          terminal: { source: "local:/apps/terminal" },
          ide: { source: "local:/apps/ide" },
        },
      },
    });

    await agentsAppsListCommand({}, runtime);

    expect(runtime.log).toHaveBeenCalledWith("Installed Agent Apps:\n- ide\n- terminal");
  });

  it("installs an npm Agent App into the registry and default selection", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          apps: ["existing"],
        },
      },
    });
    installNpmAotuiPackageMock.mockResolvedValue({
      localSource:
        "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
    });

    await agentsAppsInstallCommand({ source: "@agentina/aotui-ide" }, runtime);

    expect(installNpmAotuiPackageMock).toHaveBeenCalledWith("@agentina/aotui-ide", {
      forceReinstall: undefined,
    });
    expect(writeConfigFileMock).toHaveBeenCalledWith({
      agents: {
        defaults: {
          apps: ["existing", "aotui-ide"],
        },
      },
      apps: {
        registry: {
          "aotui-ide": {
            source:
              "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
            npmSource: "npm:@agentina/aotui-ide",
            enabled: true,
          },
        },
      },
    });
  });

  it("does not run npm install when the registry alias already exists", async () => {
    loadConfigMock.mockReturnValue({
      apps: {
        registry: {
          ide: {
            source:
              "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
          },
        },
      },
    });

    await expect(
      agentsAppsInstallCommand(
        {
          source: "@agentina/aotui-ide",
          as: "ide",
        },
        runtime,
      ),
    ).rejects.toThrow('Agent app "ide" already exists. Use --force to replace it.');

    expect(installNpmAotuiPackageMock).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("installs a local Agent App for a specific agent", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        list: [{ id: "main" }],
      },
    });

    await agentsAppsInstallCommand(
      {
        source: ".",
        as: "my-app",
        agent: "main",
      },
      runtime,
    );

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      agents: {
        list: [
          {
            id: "main",
            apps: ["my-app"],
          },
        ],
      },
      apps: {
        registry: {
          "my-app": {
            source: expect.stringMatching(/^local:/),
            enabled: true,
          },
        },
      },
    });
  });

  it("does not run npm install when the selected agent is unknown", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        list: [{ id: "main" }],
      },
    });

    await expect(
      agentsAppsInstallCommand(
        {
          source: "@agentina/aotui-ide",
          as: "ide",
          agent: "ops",
        },
        runtime,
      ),
    ).rejects.toThrow("Unknown agent: ops");

    expect(installNpmAotuiPackageMock).not.toHaveBeenCalled();
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("does not remove replaced managed cache files while another registry alias still points at the old source", async () => {
    const sharedSource =
      "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide";
    const replacementSource =
      "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/2.0.0/node_modules/@agentina/aotui-ide";
    loadConfigMock.mockReturnValue({
      apps: {
        registry: {
          ide: { source: sharedSource },
          editor: { source: sharedSource },
        },
      },
    });
    installNpmAotuiPackageMock.mockResolvedValue({
      localSource: replacementSource,
    });

    await agentsAppsInstallCommand(
      {
        source: "@agentina/aotui-ide@2.0.0",
        as: "ide",
        force: true,
        select: false,
      },
      runtime,
    );

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      apps: {
        registry: {
          ide: {
            source: replacementSource,
            npmSource: "npm:@agentina/aotui-ide@2.0.0",
            enabled: true,
          },
          editor: {
            source: sharedSource,
          },
        },
      },
    });
    expect(cleanupManagedAotuiAppArtifactsMock).not.toHaveBeenCalled();
  });

  it("cleans up a newly installed managed artifact when writing config fails", async () => {
    const installedSource =
      "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/2.0.0/node_modules/@agentina/aotui-ide";
    loadConfigMock.mockReturnValue({});
    installNpmAotuiPackageMock.mockResolvedValue({
      localSource: installedSource,
    });
    writeConfigFileMock.mockRejectedValueOnce(new Error("disk full"));

    await expect(
      agentsAppsInstallCommand(
        {
          source: "@agentina/aotui-ide@2.0.0",
        },
        runtime,
      ),
    ).rejects.toThrow("disk full");

    expect(cleanupManagedAotuiAppArtifactsMock).toHaveBeenCalledWith(installedSource);
  });

  it("uninstalls an Agent App, clears selections, and removes managed cache files", async () => {
    loadConfigMock.mockReturnValue({
      apps: {
        registry: {
          ide: {
            source:
              "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
          },
        },
      },
      agents: {
        defaults: {
          apps: ["ide", "other"],
        },
        list: [
          { id: "main", apps: ["ide"] },
          { id: "ops", apps: ["other"] },
        ],
      },
    });
    cleanupManagedAotuiAppArtifactsMock.mockResolvedValue(true);

    await agentsAppsUninstallCommand({ name: "ide" }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      apps: {
        registry: undefined,
      },
      agents: {
        defaults: {
          apps: ["other"],
        },
        list: [
          { id: "main", apps: undefined },
          { id: "ops", apps: ["other"] },
        ],
      },
    });
    expect(cleanupManagedAotuiAppArtifactsMock).toHaveBeenCalledWith(
      "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
    );
  });

  it("does not remove managed cache files while another registry alias still points at the same source", async () => {
    const sharedSource =
      "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide";
    loadConfigMock.mockReturnValue({
      apps: {
        registry: {
          ide: { source: sharedSource },
          editor: { source: sharedSource },
        },
      },
      agents: {
        defaults: {
          apps: ["ide", "editor"],
        },
      },
    });

    await agentsAppsUninstallCommand({ name: "ide" }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      apps: {
        registry: {
          editor: {
            source: sharedSource,
          },
        },
      },
      agents: {
        defaults: {
          apps: ["editor"],
        },
        list: [],
      },
    });
    expect(cleanupManagedAotuiAppArtifactsMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      [
        "Uninstalled Agent App ide.",
        "No managed cached artifacts removed.",
        "Restart the gateway to apply the change.",
      ].join("\n"),
    );
  });
});
