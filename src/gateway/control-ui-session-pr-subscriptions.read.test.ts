import { afterEach, describe, expect, it, vi } from "vitest";
import { withinTest } from "../../test/helpers/promise.js";
import { createDeferredCore } from "../shared/deferred.js";
import { createTestGatewayScheduler } from "../test-utils/gateway-scheduler-clock.js";
import type { ControlUiSessionPrTarget } from "./control-ui-session-pr-read.js";
import { createTestControlUiSessionPrSubscriptions } from "./control-ui-session-pr-subscriptions.test-support.js";

const scheduler = createTestGatewayScheduler();
let owner: ReturnType<typeof createTestControlUiSessionPrSubscriptions> | undefined;

afterEach(async () => {
  await owner?.stop();
  owner = undefined;
});

const target: ControlUiSessionPrTarget = {
  params: { sessionKey: "agent:main:change", agentId: "main" },
  identity: "original-session",
  readSource: { agentId: "main", path: "unused" },
  source: null,
};

describe("one-shot session PR reads", () => {
  it("returns the owner's snapshot without subscribing or broadcasting", async () => {
    const broadcastToConnIds = vi.fn();
    const load = vi.fn(async () => ({ pullRequests: [], rateLimited: true }));
    owner = createTestControlUiSessionPrSubscriptions({ scheduler, broadcastToConnIds, load });
    expect(await owner.read(target, () => {})).toEqual({
      pullRequests: [],
      rateLimited: true,
      status: "rate-limited",
    });
    await owner.pollNow();
    expect(load).toHaveBeenCalledTimes(1);
    expect(broadcastToConnIds).not.toHaveBeenCalled();
  });

  it("keeps a forced watcher snapshot when an older prepared read settles later", async ({
    signal,
  }) => {
    const entered = createDeferredCore();
    const release = createDeferredCore();
    const selected = { ...target, source: "/synthetic/repository" };
    owner = createTestControlUiSessionPrSubscriptions({
      scheduler,
      broadcastToConnIds: vi.fn(),
      prepareRead: async () => async () => selected,
      load: async ({ refresh }) => {
        if (!refresh) {
          entered.resolve();
          await release.promise;
        }
        return {
          pullRequests: [],
          rateLimited: false,
          repository: { owner: "synthetic", repo: refresh ? "fresh" : "old" },
        };
      },
    });
    expect(owner.readPrepared(selected)).toBeUndefined();
    const reading = owner.read(selected, () => {});
    try {
      await withinTest(entered.promise, signal);
      const { sessionKey } = selected.params;
      await withinTest(owner.replace("viewer", [sessionKey], new Set([sessionKey])), signal);
      expect(owner.readPrepared(selected)?.repository?.repo).toBe("fresh");
      release.resolve();
      await withinTest(reading, signal);
      expect(owner.readPrepared(selected)?.repository?.repo).toBe("fresh");
    } finally {
      release.resolve();
      await reading;
    }
  });

  it.each(["caller", "session", "owner"] as const)(
    "does not disclose an in-flight result after the %s retires",
    async (retired) => {
      const entered = createDeferredCore();
      const release = createDeferredCore();
      let current = true;
      const assertCurrent = () => {
        if (!current) {
          throw new Error("Read authority retired");
        }
      };
      owner = createTestControlUiSessionPrSubscriptions({
        scheduler,
        broadcastToConnIds: vi.fn(),
        load: async () => {
          entered.resolve();
          await release.promise;
          return { pullRequests: [], rateLimited: false };
        },
      });
      const reading = owner.read(
        { ...target, ...(retired === "session" ? { assertCurrent } : {}) },
        retired === "caller" ? assertCurrent : () => {},
        "publication",
      );
      const rejected = expect(reading).rejects.toThrow(/retired|closed/);
      await entered.promise;
      current = false;
      let stopped = false;
      const stopping =
        retired === "owner"
          ? owner.stop().then(() => {
              stopped = true;
            })
          : undefined;
      expect(stopped).toBe(false);
      release.resolve();
      await rejected;
      await stopping;
      if (retired === "owner") {
        expect(stopped).toBe(true);
        expect(() => owner?.read(target, () => {})).toThrow("closed");
      }
    },
  );
});
