import { afterEach, describe, expect, it, vi } from "vitest";
import { installedPluginRoot } from "../../../test/helpers/bundled-plugin-paths.js";
import { createPluginRecord, createPluginStatusReport } from "../../plugins/status.test-helpers.js";

const WORKSPACE_PLUGIN_ROOT = installedPluginRoot("/tmp/workspace/.openclaw", "superpowers");

const {
  readConfigFileSnapshotMock,
  validateConfigObjectWithPluginsMock,
  writeConfigFileMock,
  buildPluginStatusReportMock,
} = vi.hoisted(() => ({
  readConfigFileSnapshotMock: vi.fn(),
  validateConfigObjectWithPluginsMock: vi.fn(),
  writeConfigFileMock: vi.fn(),
  buildPluginStatusReportMock: vi.fn(),
}));

vi.mock("../../config/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../config/config.js")>("../../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: readConfigFileSnapshotMock,
    validateConfigObjectWithPlugins: validateConfigObjectWithPluginsMock,
    writeConfigFile: writeConfigFileMock,
  };
});

vi.mock("../../plugins/status.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../plugins/status.js")>("../../plugins/status.js");
  return {
    ...actual,
    buildPluginStatusReport: buildPluginStatusReportMock,
  };
});

import { handleCommands } from "./commands-core.js";
import { buildCommandTestParams } from "./commands.test-harness.js";

function buildCfg() {
  return {
    plugins: {
      enabled: true,
    },
    commands: {
      text: true,
      plugins: true,
    },
  };
}

describe("handleCommands /plugins toggle", () => {
  afterEach(() => {
    readConfigFileSnapshotMock.mockReset();
    validateConfigObjectWithPluginsMock.mockReset();
    writeConfigFileMock.mockReset();
    buildPluginStatusReportMock.mockReset();
  });

  it("enables a discovered plugin", async () => {
    const config = buildCfg();
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      path: "/tmp/openclaw.json",
      resolved: config,
    });
    buildPluginStatusReportMock.mockReturnValue(
      createPluginStatusReport({
        workspaceDir: "/tmp/workspace",
        plugins: [
          createPluginRecord({
            id: "superpowers",
            format: "bundle",
            source: WORKSPACE_PLUGIN_ROOT,
            enabled: false,
            status: "disabled",
          }),
        ],
      }),
    );
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));
    writeConfigFileMock.mockResolvedValue(undefined);

    const params = buildCommandTestParams("/plugins enable superpowers", buildCfg());
    params.command.senderIsOwner = true;

    const result = await handleCommands(params);
    expect(result.reply?.text).toContain('Plugin "superpowers" enabled');
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            superpowers: expect.objectContaining({ enabled: true }),
          }),
        }),
      }),
    );
  });

  it("disables a discovered plugin", async () => {
    const config = buildCfg();
    readConfigFileSnapshotMock.mockResolvedValue({
      valid: true,
      path: "/tmp/openclaw.json",
      resolved: config,
    });
    buildPluginStatusReportMock.mockReturnValue(
      createPluginStatusReport({
        workspaceDir: "/tmp/workspace",
        plugins: [
          createPluginRecord({
            id: "superpowers",
            format: "bundle",
            source: WORKSPACE_PLUGIN_ROOT,
            enabled: true,
          }),
        ],
      }),
    );
    validateConfigObjectWithPluginsMock.mockImplementation((next) => ({ ok: true, config: next }));
    writeConfigFileMock.mockResolvedValue(undefined);

    const params = buildCommandTestParams("/plugins disable superpowers", buildCfg());
    params.command.senderIsOwner = true;

    const result = await handleCommands(params);
    expect(result.reply?.text).toContain('Plugin "superpowers" disabled');
    expect(writeConfigFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plugins: expect.objectContaining({
          entries: expect.objectContaining({
            superpowers: expect.objectContaining({ enabled: false }),
          }),
        }),
      }),
    );
  });
});
