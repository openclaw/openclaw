import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PluginRuntime } from "openclaw/plugin-sdk/matrix";
import { beforeEach, describe } from "vitest";
import { __testing as discordThreadBindingTesting } from "../../../../extensions/discord/src/monitor/thread-bindings.manager.js";
import { __testing as feishuThreadBindingTesting } from "../../../../extensions/feishu/src/thread-bindings.js";
import { resetMatrixThreadBindingsForTests } from "../../../../extensions/matrix/src/matrix/thread-bindings.js";
import { setMatrixRuntime } from "../../../../extensions/matrix/src/runtime.js";
import { __testing as telegramThreadBindingTesting } from "../../../../extensions/telegram/src/thread-bindings.js";
import { __testing as sessionBindingTesting } from "../../../infra/outbound/session-binding-service.js";
import { sessionBindingContractRegistry } from "./registry.js";
import { installSessionBindingContractSuite } from "./suites.js";

beforeEach(() => {
  sessionBindingTesting.resetSessionBindingAdaptersForTests();
  discordThreadBindingTesting.resetThreadBindingsForTests();
  feishuThreadBindingTesting.resetFeishuThreadBindingsForTests();
  resetMatrixThreadBindingsForTests();
  telegramThreadBindingTesting.resetTelegramThreadBindingsForTests();
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "matrix-session-binding-contracts-"));
  setMatrixRuntime({
    config: {
      loadConfig: () => ({}),
    },
    state: {
      resolveStateDir: () => stateDir,
    },
    channel: {
      text: {
        resolveTextChunkLimit: () => 4000,
        resolveChunkMode: () => "length",
        chunkMarkdownText: (text: string) => (text ? [text] : []),
        chunkMarkdownTextWithMode: (text: string) => (text ? [text] : []),
        resolveMarkdownTableMode: () => "code",
        convertMarkdownTables: (text: string) => text,
      },
    },
  } as PluginRuntime);
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
