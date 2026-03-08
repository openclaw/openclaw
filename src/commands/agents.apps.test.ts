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
      aotui: { enabled: true },
    });
    expect(runtime.log).toHaveBeenCalledWith(
      "Enabled Agent Apps. Restart the gateway to apply the change.",
    );
  });

  it("disables Agent Apps globally", async () => {
    loadConfigMock.mockReturnValue({});

    await agentsAppsDisableCommand({}, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      aotui: { enabled: false },
    });
  });

  it("installs an npm Agent App into the registry and default selection", async () => {
    loadConfigMock.mockReturnValue({
      agents: {
        defaults: {
          aotui: {
            apps: ["existing"],
          },
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
          aotui: {
            apps: ["existing", "aotui-ide"],
          },
        },
      },
      aotui: {
        apps: {
          "aotui-ide": {
            source:
              "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
            enabled: true,
          },
        },
      },
    });
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
            aotui: {
              apps: ["my-app"],
            },
          },
        ],
      },
      aotui: {
        apps: {
          "my-app": {
            source: expect.stringMatching(/^local:/),
            enabled: true,
          },
        },
      },
    });
  });

  it("uninstalls an Agent App, clears selections, and removes managed cache files", async () => {
    loadConfigMock.mockReturnValue({
      aotui: {
        apps: {
          ide: {
            source:
              "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
          },
        },
      },
      agents: {
        defaults: {
          aotui: {
            apps: ["ide", "other"],
          },
        },
        list: [
          { id: "main", aotui: { apps: ["ide"] } },
          { id: "ops", aotui: { apps: ["other"] } },
        ],
      },
    });
    cleanupManagedAotuiAppArtifactsMock.mockResolvedValue(true);

    await agentsAppsUninstallCommand({ name: "ide" }, runtime);

    expect(writeConfigFileMock).toHaveBeenCalledWith({
      aotui: {
        apps: undefined,
      },
      agents: {
        defaults: {
          aotui: {
            apps: ["other"],
          },
        },
        list: [
          { id: "main", aotui: { apps: [] } },
          { id: "ops", aotui: { apps: ["other"] } },
        ],
      },
    });
    expect(cleanupManagedAotuiAppArtifactsMock).toHaveBeenCalledWith(
      "local:/tmp/.openclaw/agent-apps/npm/scope-agentina__aotui-ide/latest/node_modules/@agentina/aotui-ide",
    );
  });
});
