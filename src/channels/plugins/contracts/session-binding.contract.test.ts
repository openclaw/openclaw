import { beforeEach, describe } from "vitest";
import { __testing as discordThreadBindingTesting } from "../../../../extensions/discord/src/monitor/thread-bindings.manager.js";
import { __testing as feishuThreadBindingTesting } from "../../../../extensions/feishu/src/thread-bindings.js";
import { __testing as telegramThreadBindingTesting } from "../../../../extensions/telegram/src/thread-bindings.js";
import { __testing as sessionBindingTesting } from "../../../infra/outbound/session-binding-service.js";
import { sessionBindingContractRegistry } from "./registry.js";
import { installSessionBindingContractSuite } from "./suites.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  discordThreadBindingTesting.resetThreadBindingsForTests();
  feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
  telegramThreadBindingTesting.resetTelegramThreadBindingsForTests();
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
