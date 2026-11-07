import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { routeReply } from "../../auto-reply/reply/route-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isPlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  installDeliveryQueueTmpDirHooks,
  loadPendingDeliveries,
} from "../../infra/outbound/delivery-queue.test-helpers.js";
import {
  bindPluginRegistryGatewayOwner,
  markPluginRegistryRetired,
} from "../../plugins/registry-lifecycle.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "../../plugins/runtime/load-context.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import type { ChannelMessageSendTextContext } from "../message/types.js";

const channel = "fixturechat";
const cfg: OpenClawConfig = { channels: { [channel]: { enabled: true } } };
const borrowerError = "Channel runtime borrower is no longer active";

function setConfig(registry: ReturnType<typeof createTestRegistry>, config: OpenClawConfig) {
  setPluginRuntimeLoadContext(registry, {
    rawConfig: config,
    config,
    activationSourceConfig: config,
    autoEnabledReasons: {},
    workspaceDir: undefined,
    env: {},
    logger: { info() {}, warn() {}, error() {}, debug() {} },
  });
}

/** A Gateway publication plus a turn registry that borrowed its channel and has now retired. */
function retiredTurnFixture() {
  const sendText = vi.fn(async (_ctx: ChannelMessageSendTextContext) => ({
    messageId: "gateway-final",
  }));
  const beforeSendAttempt = vi.fn(async () => {});
  const plugin = {
    ...createChannelTestPluginBase({ id: channel }),
    message: {
      id: channel,
      durableFinal: { capabilities: { text: true } },
      send: { text: sendText, lifecycle: { beforeSendAttempt } },
    },
  };
  const current = createTestRegistry([{ pluginId: channel, source: "test", plugin }], {
    config: cfg,
  });
  setConfig(current, cfg);
  const publication: { current: typeof current | undefined } = { current };
  const owner = { current: () => publication.current };
  bindPluginRegistryGatewayOwner(current, owner);
  // The retired turn's borrowed channel refuses every call, as the borrowing wrapper does.
  const refuse = () => {
    throw new Error(borrowerError);
  };
  const turn = createTestRegistry([
    {
      pluginId: channel,
      source: "test",
      plugin: {
        ...createChannelTestPluginBase({ id: channel }),
        message: {
          id: channel,
          durableFinal: { capabilities: { text: true } },
          send: { text: refuse },
        },
      },
    },
  ]);
  bindPluginRegistryGatewayOwner(turn, owner, current);
  markPluginRegistryRetired(turn);
  // A different process-root registry must never become the delivery owner.
  setActivePluginRegistry(createTestRegistry([]));
  const route = (assertCurrent?: () => void) =>
    withPluginRuntimeRegistryScope(turn, () =>
      routeReply({
        payload: { text: "background job finished" },
        channel,
        to: "room-1",
        cfg,
        replyKind: "final",
        mirror: false,
        ...(assertCurrent ? { assertCurrent } : {}),
      }),
    );
  return { publication, sendText, beforeSendAttempt, route };
}

describe("routed replies from a retired turn registry", () => {
  const state = installDeliveryQueueTmpDirHooks();
  beforeEach(() => vi.stubEnv("OPENCLAW_STATE_DIR", state.tmpDir()));
  afterEach(() => {
    resetPluginRuntimeStateForTest();
    vi.unstubAllEnvs();
  });

  it("sends through the admitting Gateway's current channel", async () => {
    const { sendText, route } = retiredTurnFixture();
    const result = await route();
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, delivered: true, messageId: "gateway-final" });
    expect(sendText.mock.calls.map(([ctx]) => ctx.text)).toEqual(["background job finished"]);
    expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
  });

  it.each(["replaced", "closed"] as const)(
    "sends nothing when the Gateway is %s during send preparation",
    async (change) => {
      const { publication, sendText, beforeSendAttempt, route } = retiredTurnFixture();
      beforeSendAttempt.mockImplementationOnce(async () => {
        publication.current = change === "closed" ? undefined : createTestRegistry([]);
      });
      const result = await route();
      expect(result).toMatchObject({ ok: false, delivered: false });
      expect(result.error).toContain("runtime changed");
      expect(sendText).not.toHaveBeenCalled();
      expect(await loadPendingDeliveries(state.tmpDir())).toEqual([]);
    },
  );

  it("sends nothing when the producer loses authority during send preparation", async () => {
    const { sendText, beforeSendAttempt, route } = retiredTurnFixture();
    let revoked = false;
    beforeSendAttempt.mockImplementationOnce(async () => {
      revoked = true;
    });
    const result = await route(() => {
      if (revoked) {
        throw new Error("producer authority revoked");
      }
    });
    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(result.error).toContain("producer authority revoked");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("rejects before any send when the admitting Gateway is gone", async () => {
    const { publication, sendText, route } = retiredTurnFixture();
    publication.current = undefined;
    const result = await route();
    expect(result).toMatchObject({ ok: false, delivered: false });
    expect(isPlatformMessageNotDispatchedError(result.cause)).toBe(true);
    expect(sendText).not.toHaveBeenCalled();
  });
});
