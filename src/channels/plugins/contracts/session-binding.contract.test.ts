import { beforeEach, describe, vi } from "vitest";
import { __testing as discordThreadBindingTesting } from "../../../../extensions/discord/src/monitor/thread-bindings.manager.js";
import { __testing as feishuThreadBindingTesting } from "../../../../extensions/feishu/src/thread-bindings.js";
import { resetMatrixThreadBindingsForTests } from "../../../../extensions/matrix/api.js";
import { __testing as telegramThreadBindingTesting } from "../../../../extensions/telegram/src/thread-bindings.js";
import { __testing as sessionBindingTesting } from "../../../infra/outbound/session-binding-service.js";
import { sessionBindingContractRegistry } from "./registry.js";
import { installSessionBindingContractSuite } from "./suites.js";

vi.mock("../../../../extensions/matrix/src/matrix/send.js", async () => {
  const actual = await vi.importActual<
    typeof import("../../../../extensions/matrix/src/matrix/send.js")
  >("../../../../extensions/matrix/src/matrix/send.js");
  return {
    ...actual,
    sendMessageMatrix: vi.fn(
      async (_to: string, _message: string, opts?: { threadId?: string }) => ({
        messageId: opts?.threadId ? "$reply" : "$root",
        roomId: "!room:example",
      }),
    ),
  };
});

beforeEach(async () => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  discordThreadBindingTesting.resetThreadBindingsForTests();
  feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
  resetMatrixThreadBindingsForTests();
  await telegramThreadBindingTesting.resetTelegramThreadBindingsForTests();
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
