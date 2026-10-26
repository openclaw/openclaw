import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createReplyRuntimeMocks,
  createTempHomeHarness,
  installReplyRuntimeMocks,
  makeEmbeddedTextResult,
  makeReplyConfig,
  resetReplyRuntimeMocks,
} from "../reply.test-harness.js";
import { loadGetReplyModuleForTest } from "./get-reply.test-loader.js";
import { createModelSelectionStateFixture } from "./model-selection.test-support.js";

vi.mock("./model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./model-selection.js")>()),
  createModelSelectionState: vi.fn<typeof import("./model-selection.js").createModelSelectionState>(
    async (params) => createModelSelectionStateFixture(params),
  ),
}));

let getReplyFromConfig: typeof import("./get-reply.js").getReplyFromConfig;
const agentMocks = createReplyRuntimeMocks();
const { withTempHome } = createTempHomeHarness({ prefix: "openclaw-getreply-fast-" });

installReplyRuntimeMocks(agentMocks);

function installRuntimeChannels() {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "telegram",
        plugin: createChannelTestPluginBase({ id: "telegram" }),
        source: "test",
      },
    ]),
  );
}

beforeAll(async () => {
  installRuntimeChannels();
  ({ getReplyFromConfig } = await loadGetReplyModuleForTest({ cacheKey: import.meta.url }));
});

beforeEach(() => {
  vi.stubEnv("OPENCLAW_TEST_FAST", "1");
  resetReplyRuntimeMocks(agentMocks);
  agentMocks.runEmbeddedAgent.mockResolvedValue(makeEmbeddedTextResult("ok"));
  installRuntimeChannels();
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry([]));
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

it.each(["native", "normal"] as const)(
  "routes structured %s turns before legacy sync",
  async (kind) => {
    await withTempHome(async (home) => {
      const native = kind === "native";
      const target = "agent:main:telegram:direct:target";
      const source = native ? "telegram:slash:source" : "agent:main:telegram:direct:source";
      await getReplyFromConfig(
        {
          Body: "hello",
          ChatType: "direct",
          ...(!native ? { CommandSource: "native" as const } : {}),
          CommandTurn: native
            ? { kind: "native", source: "native", authorized: true }
            : { kind: "normal", source: "message", authorized: false },
          CommandTargetSessionKey: target,
          SessionKey: source,
          Provider: "telegram",
          Surface: "telegram",
        },
        {},
        makeReplyConfig(home),
      );

      expect(agentMocks.runEmbeddedAgent).toHaveBeenCalledWith(
        expect.objectContaining({ sessionKey: native ? target : source }),
      );
    });
  },
);
