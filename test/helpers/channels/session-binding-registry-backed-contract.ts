import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionBindingContractChannelIds } from "../../../src/channels/plugins/contracts/manifest.js";
import { getSessionBindingContractRegistry } from "../../../src/channels/plugins/contracts/registry-session-binding.js";
import { setChannelPluginRegistryForTests } from "../../../src/commands/channel-test-registry.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../src/config/config.js";
import {
  __testing as sessionBindingTesting,
  type SessionBindingCapabilities,
  type SessionBindingRecord,
} from "../../../src/infra/outbound/session-binding-service.js";
import { resetPluginRuntimeStateForTest } from "../../../src/plugins/runtime.js";
import { loadBundledPluginTestApiSync } from "../../../src/test-utils/bundled-plugin-public-surface.js";

type DiscordThreadBindingTesting = {
  resetThreadBindingsForTests: () => void;
};

type ResetTelegramThreadBindingsForTests = () => Promise<void>;

let discordThreadBindingTestingCache: DiscordThreadBindingTesting | undefined;
let resetTelegramThreadBindingsForTestsCache: ResetTelegramThreadBindingsForTests | undefined;
let feishuApiPromise: Promise<typeof import("../../../extensions/feishu/api.js")> | undefined;
let matrixApiPromise: Promise<typeof import("../../../extensions/matrix/api.js")> | undefined;

function getDiscordThreadBindingTesting(): DiscordThreadBindingTesting {
  if (!discordThreadBindingTestingCache) {
    ({ discordThreadBindingTesting: discordThreadBindingTestingCache } =
      loadBundledPluginTestApiSync<{
        discordThreadBindingTesting: DiscordThreadBindingTesting;
      }>("discord"));
  }
  return discordThreadBindingTestingCache;
}

function getResetTelegramThreadBindingsForTests(): ResetTelegramThreadBindingsForTests {
  if (!resetTelegramThreadBindingsForTestsCache) {
    ({ resetTelegramThreadBindingsForTests: resetTelegramThreadBindingsForTestsCache } =
      loadBundledPluginTestApiSync<{
        resetTelegramThreadBindingsForTests: ResetTelegramThreadBindingsForTests;
      }>("telegram"));
  }
  return resetTelegramThreadBindingsForTestsCache;
}

async function getFeishuThreadBindingTesting() {
  feishuApiPromise ??= import("../../../extensions/feishu/api.js");
  return (await feishuApiPromise).feishuThreadBindingTesting;
}

async function getResetMatrixThreadBindingsForTests() {
  matrixApiPromise ??= import("../../../extensions/matrix/api.js");
  return (await matrixApiPromise).resetMatrixThreadBindingsForTests;
}

function resolveSessionBindingContractRuntimeConfig(id: string) {
  if (id !== "discord" && id !== "matrix") {
    return null;
  }
  return {
    plugins: {
      entries: {
        [id]: {
          enabled: true,
        },
      },
    },
  };
}

function installSessionBindingContractSuite(params: {
  getCapabilities: () => SessionBindingCapabilities | Promise<SessionBindingCapabilities>;
  bindAndResolve: () => Promise<SessionBindingRecord>;
  unbindAndVerify: (binding: SessionBindingRecord) => Promise<void>;
  cleanup: () => Promise<void> | void;
  expectedCapabilities: SessionBindingCapabilities;
}) {
  it("registers the expected session binding capabilities", async () => {
    expect(await Promise.resolve(params.getCapabilities())).toEqual(params.expectedCapabilities);
  });

  it("binds and resolves a session binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
    expect(typeof binding.bindingId).toBe("string");
    expect(binding.bindingId.trim()).not.toBe("");
    expect(typeof binding.targetSessionKey).toBe("string");
    expect(binding.targetSessionKey.trim()).not.toBe("");
    expect(["session", "subagent"]).toContain(binding.targetKind);
    expect(typeof binding.conversation.channel).toBe("string");
    expect(typeof binding.conversation.accountId).toBe("string");
    expect(typeof binding.conversation.conversationId).toBe("string");
    expect(["active", "ending", "ended"]).toContain(binding.status);
    expect(typeof binding.boundAt).toBe("number");
  });

  it("unbinds a registered binding through the shared service", async () => {
    const binding = await params.bindAndResolve();
    await params.unbindAndVerify(binding);
  });

  it("cleans up registered bindings", async () => {
    await params.cleanup();
  });
}

export function describeSessionBindingRegistryBackedContract(id: string) {
  const entry = getSessionBindingContractRegistry().find((item) => item.id === id);
  if (!entry) {
    throw new Error(`missing session binding contract entry for ${id}`);
  }

  describe(`${entry.id} session binding contract`, () => {
    beforeEach(async () => {
      resetPluginRuntimeStateForTest();
      clearRuntimeConfigSnapshot();
      const runtimeConfig = resolveSessionBindingContractRuntimeConfig(entry.id);
      if (runtimeConfig) {
        // These registry-backed contract suites intentionally exercise bundled runtime facades.
        // Opt those specific plugins in so the activation boundary behaves like real runtime usage.
        setRuntimeConfigSnapshot(runtimeConfig);
      }
      // These suites only exercise the session-binding channels, so keep the seeded registry narrow.
      setChannelPluginRegistryForTests(sessionBindingContractChannelIds);
      sessionBindingTesting.resetSessionBindingAdaptersForTests();
      getDiscordThreadBindingTesting().resetThreadBindingsForTests();
      (await getFeishuThreadBindingTesting()).resetFeishuThreadBindingsForTests();
      (await getResetMatrixThreadBindingsForTests())();
      await getResetTelegramThreadBindingsForTests()();
    });
    afterEach(() => {
      clearRuntimeConfigSnapshot();
    });

    installSessionBindingContractSuite({
      expectedCapabilities: entry.expectedCapabilities,
      getCapabilities: entry.getCapabilities,
      bindAndResolve: entry.bindAndResolve,
      unbindAndVerify: entry.unbindAndVerify,
      cleanup: entry.cleanup,
    });
  });
}
