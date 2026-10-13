import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { preparePluginMetadataMachineStateAsync } from "../../plugins/installed-plugin-index-record-state.js";
import { runMessageAction } from "./message-action-runner.js";
import {
  createMessageActionContextFixture,
  workspaceConfig,
} from "./message-action-runner.test-support.js";

const contextFixture = createMessageActionContextFixture();

describe("runMessageAction context isolation", () => {
  beforeEach(async () => {
    contextFixture.setup();
    await preparePluginMetadataMachineStateAsync({});
  });
  afterEach(() => contextFixture.cleanup());
  it.each([
    { params: { channel: "C_TARGET" }, error: 'Unknown channel "c_target"' },
    { params: { targets: ["C_TARGET"] }, error: "Action read requires a target." },
  ])("rejects read selectors: $error", async ({ params, error }) => {
    await expect(
      runMessageAction({
        cfg: workspaceConfig,
        action: "read",
        params,
        defaultAccountId: "default",
        requesterAccountId: "default",
        conversationReadOrigin: "delegated",
        toolContext: {
          currentChannelId: "C_CURRENT",
          currentChannelProvider: "workspace",
        },
        dryRun: false,
      }),
    ).rejects.toThrow(error);
    expect(contextFixture.handleWorkspaceAction).not.toHaveBeenCalled();
  });
});
