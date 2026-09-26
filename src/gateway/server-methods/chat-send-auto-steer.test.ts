import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { createAdmittedRunOperatorAuthority } from "../../agents/admitted-run-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type {
  PluginHookInputRouteContext,
  PluginHookInputRouteResult,
} from "../../plugins/hook-types.js";
import { prepareChatSendRouting } from "./chat-send-auto-steer.js";

const mocks = vi.hoisted(() => ({
  current: vi.fn(),
  read: vi.fn(),
  evaluate: vi.fn(),
  prepare: vi.fn(),
  inspect: vi.fn(),
}));
vi.mock("../../auto-reply/reply/reply-run-registry.js", () => ({
  replyRunRegistry: { get: mocks.current },
}));
vi.mock("../../config/sessions/session-history-worker-runtime.js", () => ({
  readSessionHistoryPageInWorker: mocks.read,
}));
vi.mock("../../plugins/hook-runner-global.js", () => ({
  getGlobalHookRunner: () => ({ prepareInputRoute: mocks.prepare }),
}));
vi.mock("../../decisions/runtime.js", () => ({ inspectDecisionProviders: mocks.inspect }));
type Params = Parameters<typeof prepareChatSendRouting>[0];
const page = {
  messages: [{ role: "user", idempotencyKey: "source:user", content: "Write a parser." }],
};
let now = 1000;
function fixture() {
  const config: OpenClawConfig = {
    agents: {
      defaults: { experimental: { decisionAssistance: true }, decisionModel: "test/decision" },
    },
  };
  const inputAbort = new AbortController();
  const operation = { turnKind: "visible", abortSignal: new AbortController().signal };
  const target = { sourceTurnId: "source" };
  const params = {
    request: {
      p: { deliveryPolicy: "auto", queueMode: "followup" },
      rawMessage: "Handle tabs.",
      normalizedAttachments: [],
      turnKind: "main",
    },
    session: {
      agentId: "main",
      activeRunScopeKey: "session",
      sessionKey: "session",
      storePath: "unused.sqlite",
      entry: { sessionId: "session-id" },
    },
    admission: {
      autoSteerTarget: target,
      expectedActiveReplyOperation: operation,
      activeRunAbort: { controller: inputAbort },
      inputRouting: { ready: Promise.resolve(), release: vi.fn() },
    },
    client: { connect: { client: { id: "openclaw-control-ui" }, role: "operator" } },
    assertCurrent: vi.fn(),
    getConfig: () => config,
  } as unknown as Params;
  mocks.inspect.mockReturnValue([
    { providerId: "test", pluginId: "test", callable: true, runtimeGeneration: "fixture" },
  ]);
  mocks.current.mockReturnValue(operation);
  mocks.read.mockResolvedValue(page);
  mocks.evaluate.mockResolvedValue({ status: "choice", choice: "steer" });
  mocks.prepare.mockImplementation((eligible: (id: string) => boolean) =>
    eligible("auto-steer")
      ? { isCurrent: () => eligible("auto-steer"), evaluate: mocks.evaluate }
      : undefined,
  );
  return { params, config, target, inputAbort };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  now = 1000;
  vi.spyOn(performance, "now").mockImplementation(() => now);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("host Auto routing boundary", () => {
  it.each([
    "labs-off",
    "no-model",
    "auto-off",
    "slash",
    "bang",
    "reply",
    "incognito",
    "other-client",
    "oversized",
    "inherited-interrupt",
  ])("does no optional work for %s", async (kind) => {
    const { params, config } = fixture();
    if (kind === "labs-off") {
      config.agents!.defaults!.experimental!.decisionAssistance = false;
    }
    if (kind === "no-model") {
      config.agents!.defaults!.decisionModel = "";
    }
    if (kind === "auto-off") {
      delete params.request.p.deliveryPolicy;
    }
    if (kind === "slash") {
      params.request.rawMessage = "/help";
    }
    if (kind === "bang") {
      params.request.rawMessage = "  !pwd";
    }
    if (kind === "reply") {
      params.request.p.replyToId = "message";
    }
    if (kind === "incognito") {
      params.session.entry!.incognito = true;
    }
    if (kind === "other-client") {
      params.client!.connect.client.id = "openclaw-ios";
    }
    if (kind === "oversized") {
      params.request.rawMessage = "x".repeat(8001);
    }
    if (kind === "inherited-interrupt") {
      delete params.request.p.queueMode;
      config.messages = { queue: { mode: "interrupt" } };
    }
    await prepareChatSendRouting(params);
    expect(mocks.prepare).not.toHaveBeenCalled();
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it.each(["ordering", "preparation"])(
    "expires advice after %s without another provider call",
    async (phase) => {
      const { params } = fixture();
      const waiting = createDeferred();
      const hold = createDeferred();
      params.admission.inputRouting = {
        get ready() {
          waiting.resolve();
          return hold.promise;
        },
        release: vi.fn(),
      };
      const pending = prepareChatSendRouting(params);
      await waiting.promise;
      expect(params.request.autoSteer?.reason).toBe("decision");
      if (phase === "ordering") {
        now += 501;
      }
      hold.resolve();
      const revalidate = await pending;
      if (phase === "preparation") {
        now += 501;
        revalidate.revalidate();
      }
      expect(params.request.autoSteer).toEqual({ reason: "deadline" });
      expect(params.request.resolvedQueueMode).toBe("followup");
      expect(params.admission.messageInjectionTarget).toBeUndefined();
      expect(mocks.evaluate).toHaveBeenCalledOnce();
    },
  );
  it("keeps inherited steer fallback bound to the original captured target", async () => {
    const { params, target } = fixture();
    delete params.request.p.queueMode;
    mocks.evaluate.mockResolvedValue({ status: "abstained" });
    await prepareChatSendRouting(params);
    expect(params.request.resolvedQueueMode).toBe("steer");
    expect(params.admission.messageInjectionTarget).toBe(target);
  });
  it("preserves the submitted inherited baseline when config changes before fallback", async () => {
    const { params, config, target } = fixture();
    delete params.request.p.queueMode;
    mocks.evaluate.mockResolvedValue({ status: "choice", choice: "followup" });
    const routing = await prepareChatSendRouting(params);
    config.messages = { queue: { mode: "interrupt" } };
    now += 501;
    routing.revalidate();
    expect(params.request.resolvedQueueMode).toBe("steer");
    expect(params.admission.messageInjectionTarget).toBe(target);
  });
  it("does not revoke accepted custody when advice expires, but still checks caller authority", async () => {
    const { params, target } = fixture();
    const routing = await prepareChatSendRouting(params);
    routing.takeCustody();
    routing.takeCustody();
    now += 501;
    routing.revalidate();
    expect(params.request.autoSteer).toEqual({ reason: "decision", choice: "steer" });
    expect(params.admission.messageInjectionTarget).toBe(target);
    expect(params.admission.inputRouting?.release).toHaveBeenCalledOnce();
    params.assertCurrent = () => {
      throw new Error("revoked");
    };
    expect(routing.revalidate).toThrow("revoked");
  });
  it("checks plugin enablement before preparing history", async () => {
    const { params, config } = fixture();
    config.plugins = { entries: { "auto-steer": { enabled: false } } };
    await prepareChatSendRouting(params);
    expect(mocks.read).not.toHaveBeenCalled();
    expect(mocks.evaluate).not.toHaveBeenCalled();
  });
  it("uses the captured target and restores the followup baseline after gate revocation", async () => {
    const { params, config, target } = fixture();
    const revalidate = await prepareChatSendRouting(params);
    expect(params.admission.messageInjectionTarget).toBe(target);
    expect(params.request.autoSteer).toEqual({ choice: "steer", reason: "decision" });
    config.agents!.defaults!.experimental!.decisionAssistance = false;
    revalidate.revalidate();
    expect(params.admission.messageInjectionTarget).toBeUndefined();
    expect(params.request.resolvedQueueMode).toBe("followup");
  });
  it.each(["target", "labs", "model", "provider", "authority"])(
    "rechecks %s after history before disclosure",
    async (change) => {
      const { params, config } = fixture();
      mocks.read.mockImplementation(async () => {
        if (change === "target") {
          mocks.current.mockReturnValue({ successor: true });
        }
        if (change === "labs") {
          config.agents!.defaults!.experimental!.decisionAssistance = false;
        }
        if (change === "model") {
          config.agents!.defaults!.decisionModel = "test/replacement";
        }
        if (change === "provider") {
          mocks.inspect.mockReturnValue([
            {
              providerId: "test",
              pluginId: "test",
              callable: true,
              runtimeGeneration: "replacement",
            },
          ]);
        }
        if (change === "authority") {
          params.assertCurrent = () => {
            throw new Error("revoked");
          };
        }
        return page;
      });
      if (change === "authority") {
        await expect(prepareChatSendRouting(params)).rejects.toThrow("revoked");
      } else {
        await prepareChatSendRouting(params);
      }
      expect(mocks.evaluate).not.toHaveBeenCalled();
      expect(params.admission.messageInjectionTarget).toBeUndefined();
    },
  );
  it("rechecks selected decision-model policy rather than only generic operator authority", async () => {
    const { params } = fixture();
    let allowed = true;
    params.admission.operatorAuthority = createAdmittedRunOperatorAuthority({
      profileId: "fixture",
      scopes: ["operator.admin"],
      assertCurrent: () => {},
      modelPolicy: { models: [], allows: () => allowed },
    });
    mocks.evaluate.mockImplementation(async () => {
      allowed = false;
      return { status: "choice", choice: "steer" };
    });
    await expect(prepareChatSendRouting(params)).rejects.toThrow("cannot use this model");
    expect(params.admission.messageInjectionTarget).toBeUndefined();
  });
  it.each(["history", "inference"])(
    "checks elapsed %s even before a delayed timer fires",
    async (phase) => {
      const { params } = fixture();
      if (phase === "history") {
        mocks.read.mockImplementation(async () => {
          now += 501;
          return page;
        });
      } else {
        mocks.evaluate.mockImplementation(async () => {
          now += 501;
          return { status: "choice", choice: "steer" };
        });
      }
      await prepareChatSendRouting(params);
      expect(params.request.autoSteer).toEqual({ reason: "deadline" });
      expect(params.request.resolvedQueueMode).toBe("followup");
      if (phase === "history") {
        expect(mocks.evaluate).not.toHaveBeenCalled();
      }
    },
  );
  it.each(["cancel", "authority", "deadline"])(
    "keeps %s distinct while inference is pending",
    async (end) => {
      const { params, inputAbort } = fixture();
      const started = createDeferred();
      const result = createDeferred<PluginHookInputRouteResult>();
      let retained: PluginHookInputRouteContext | undefined;
      mocks.evaluate.mockImplementation((_event, context) => {
        retained = context;
        started.resolve();
        return result.promise;
      });
      const observed = prepareChatSendRouting(params).then(
        () => "ok",
        (error: unknown) => {
          if (!(error instanceof Error)) {
            throw error;
          }
          return error.message;
        },
      );
      await started.promise;
      if (end === "cancel") {
        inputAbort.abort(new Error("cancelled"));
      }
      if (end === "authority") {
        params.assertCurrent = () => {
          throw new Error("revoked");
        };
      }
      now += 500;
      await vi.advanceTimersByTimeAsync(500);
      expect(await observed).toBe(
        end === "cancel" ? "cancelled" : end === "authority" ? "revoked" : "ok",
      );
      if (end === "deadline") {
        expect(params.request.autoSteer).toEqual({ reason: "deadline" });
      }
      expect(() => retained!.assertCurrent()).toThrow();
      result.resolve({ status: "choice", choice: "steer" });
      await Promise.resolve();
      expect(params.admission.messageInjectionTarget).toBeUndefined();
      expect(mocks.evaluate).toHaveBeenCalledTimes(1);
    },
  );
});
