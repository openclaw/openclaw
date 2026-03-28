import { beforeEach, describe } from "vitest";
import { __testing as bluebubblesBindingTesting } from "../../../../extensions/bluebubbles/api.js";
import { __testing as iMessageBindingTesting } from "../../../../extensions/imessage/api.js";
import { __testing as sessionBindingTesting } from "../../../infra/outbound/session-binding-service.js";
import { discordThreadBindingTesting } from "../../../plugin-sdk/discord.js";
import { feishuThreadBindingTesting } from "../../../plugin-sdk/feishu-conversation.js";
import { resetMatrixThreadBindingsForTests } from "../../../plugin-sdk/matrix.js";
import { resetTelegramThreadBindingsForTests } from "../../../plugin-sdk/telegram-runtime-surface.js";
import {
  actionContractRegistry,
  directoryContractRegistry,
  pluginContractRegistry,
  sessionBindingContractRegistry,
  setupContractRegistry,
  statusContractRegistry,
  surfaceContractRegistry,
  threadingContractRegistry,
} from "./registry.js";
import {
  installChannelActionsContractSuite,
  installChannelDirectoryContractSuite,
  installChannelPluginContractSuite,
  installChannelSetupContractSuite,
  installChannelStatusContractSuite,
  installChannelSurfaceContractSuite,
  installChannelThreadingContractSuite,
  installSessionBindingContractSuite,
} from "./suites.js";

for (const entry of pluginContractRegistry) {
  describe(`${entry.id} plugin contract`, () => {
    installChannelPluginContractSuite({
      plugin: entry.plugin,
    });
  });
}

for (const entry of actionContractRegistry) {
  describe(`${entry.id} actions contract`, () => {
    installChannelActionsContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
      unsupportedAction: entry.unsupportedAction as never,
    });
  });
}

for (const entry of setupContractRegistry) {
  describe(`${entry.id} setup contract`, () => {
    installChannelSetupContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}

for (const entry of statusContractRegistry) {
  describe(`${entry.id} status contract`, () => {
    installChannelStatusContractSuite({
      plugin: entry.plugin,
      cases: entry.cases as never,
    });
  });
}

for (const entry of surfaceContractRegistry) {
  for (const surface of entry.surfaces) {
    describe(`${entry.id} ${surface} surface contract`, () => {
      installChannelSurfaceContractSuite({
        plugin: entry.plugin,
        surface,
      });
    });
  }
}

for (const entry of threadingContractRegistry) {
  describe(`${entry.id} threading contract`, () => {
    installChannelThreadingContractSuite({
      plugin: entry.plugin,
    });
  });
}

for (const entry of directoryContractRegistry) {
  describe(`${entry.id} directory contract`, () => {
    installChannelDirectoryContractSuite({
      plugin: entry.plugin,
      coverage: entry.coverage,
      cfg: entry.cfg,
      accountId: entry.accountId,
    });
  });
}

describe("session binding contract registry", () => {
  beforeEach(async () => {
    bluebubblesBindingTesting.resetBlueBubblesConversationBindingsForTests();
    iMessageBindingTesting.resetIMessageConversationBindingsForTests();
    sessionBindingTesting.resetSessionBindingAdaptersForTests();
    discordThreadBindingTesting.resetThreadBindingsForTests();
    feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
    resetMatrixThreadBindingsForTests();
    await resetTelegramThreadBindingsForTests();
  });

  for (const entry of sessionBindingContractRegistry) {
    describe(`${entry.id} session binding contract`, () => {
      installSessionBindingContractSuite({
        expectedCapabilities: entry.expectedCapabilities,
        getCapabilities: entry.getCapabilities,
        bindAndResolve: entry.bindAndResolve,
        unbindAndVerify: entry.unbindAndVerify,
        cleanup: entry.cleanup,
      });
    });
  }
});
