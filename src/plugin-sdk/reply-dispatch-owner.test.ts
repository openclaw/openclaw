import { describe, expect, it, vi } from "vitest";
import { buildTestCtx } from "../auto-reply/reply/test-ctx.js";
import {
  bindLegacyPluginSdkResourceHost,
  LegacyPluginSdkResourceHost,
  type LegacyPluginSdkReplyDispatch,
} from "../plugins/legacy-sdk-resource-host.js";
import { createIdleReplyDispatcher } from "../plugins/reply-dispatch.test-support.js";
import { withPluginRuntimeGatewayRequestScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginHookReplyDispatchEvent } from "../plugins/types.js";
import { createDeferredCore } from "../shared/deferred.js";
import { tryDispatchAcpReplyHook } from "./acpx.js";
import {
  dispatchReplyWithBufferedBlockDispatcher,
  dispatchReplyWithDispatcher,
} from "./reply-dispatch-runtime.js";

const result = { queuedFinal: false, counts: { tool: 0, block: 0, final: 1 } };
const event: PluginHookReplyDispatchEvent = {
  ctx: buildTestCtx({ SessionKey: "agent:test:dispatch-owner", Body: "hello" }),
  sessionKey: "agent:test:dispatch-owner",
  inboundAudio: false,
  sessionTtsAuto: "off",
  suppressUserDelivery: false,
  shouldRouteToOriginating: false,
  shouldSendToolSummaries: true,
  shouldSendFullToolDetails: false,
  sendPolicy: "allow",
};
const context = {
  cfg: {},
  dispatcher: createIdleReplyDispatcher(),
  recordProcessed: () => {},
  markIdle: () => {},
};
const providerParams = {
  ctx: event.ctx,
  cfg: {},
  dispatcherOptions: { deliver: async () => {} },
};

function makeOwner() {
  const reply = {
    tryDispatchAcpReplyHook: vi.fn<LegacyPluginSdkReplyDispatch["tryDispatchAcpReplyHook"]>(
      async () => ({ handled: true, ...result }),
    ),
    dispatchReplyWithBufferedBlockDispatcher: vi.fn<
      LegacyPluginSdkReplyDispatch["dispatchReplyWithBufferedBlockDispatcher"]
    >(async () => result),
    dispatchReplyWithDispatcher: vi.fn<LegacyPluginSdkReplyDispatch["dispatchReplyWithDispatcher"]>(
      async () => result,
    ),
  };
  return { host: new LegacyPluginSdkResourceHost(reply), reply };
}

type SurfaceResult = Awaited<
  ReturnType<LegacyPluginSdkReplyDispatch[keyof LegacyPluginSdkReplyDispatch]>
>;

const surfaces: { name: string; call: () => Promise<SurfaceResult> }[] = [
  { name: "ACP", call: () => tryDispatchAcpReplyHook(event, context) },
  { name: "buffered", call: () => dispatchReplyWithBufferedBlockDispatcher(providerParams) },
  { name: "plain", call: () => dispatchReplyWithDispatcher(providerParams) },
];

describe("SDK reply dispatch ownership", () => {
  it.each(surfaces)("keeps retained $name calls with their closed owner", async ({ call }) => {
    const a = makeOwner();
    const b = makeOwner();
    const releaseLateCall = createDeferredCore();
    const { inherited } = a.host.invoke(() => ({
      inherited: releaseLateCall.promise.then(() => call()),
    }));
    const resolver = vi.fn(() => undefined);
    bindLegacyPluginSdkResourceHost(resolver, a.host);
    const retained = () =>
      b.host.run(() =>
        withPluginRuntimeGatewayRequestScope(
          { resolveGatewayContext: resolver, isWebchatConnect: () => false },
          call,
        ),
      );
    try {
      await a.host.close();
      await b.host.run(call);
      await expect(retained()).rejects.toThrow("closed");
      releaseLateCall.resolve();
      await expect(inherited).rejects.toThrow("closed");
      expect(resolver).not.toHaveBeenCalled();
      expect(
        Object.values(a.reply).reduce((total, method) => total + method.mock.calls.length, 0),
      ).toBe(0);
      expect(
        Object.values(b.reply).reduce((total, method) => total + method.mock.calls.length, 0),
      ).toBe(1);
    } finally {
      releaseLateCall.resolve();
      await Promise.allSettled([inherited, a.host.close(), b.host.close()]);
    }
  });

  it.each(surfaces)("refuses bound $name without a bundle", async ({ call }) => {
    const host = new LegacyPluginSdkResourceHost();
    try {
      await expect(host.run(call)).rejects.toThrow("no reply dispatch runtime");
    } finally {
      await host.close();
    }
  });

  it("joins an admitted ACP operation and its provider descendant during close", async () => {
    const { host, reply } = makeOwner();
    const resume = createDeferredCore();
    reply.tryDispatchAcpReplyHook.mockImplementationOnce(async () => {
      await resume.promise;
      await dispatchReplyWithDispatcher(providerParams);
      return { handled: true, ...result };
    });
    const operation = host.run(() => tryDispatchAcpReplyHook(event, context));
    const closed = host.close();
    try {
      await expect(host.run(() => dispatchReplyWithDispatcher(providerParams))).rejects.toThrow(
        "closed",
      );
      expect(reply.dispatchReplyWithDispatcher).not.toHaveBeenCalled();
      resume.resolve();
      await expect(operation).resolves.toEqual({ handled: true, ...result });
      await closed;
      expect(reply.dispatchReplyWithDispatcher).toHaveBeenCalledExactlyOnceWith(providerParams);
    } finally {
      resume.resolve();
      await Promise.allSettled([operation, closed]);
    }
  });

  it("preserves the accepted operation's rejection while joining close", async () => {
    const { host, reply } = makeOwner();
    const resume = createDeferredCore();
    const failure = new Error("synthetic dispatch failure");
    reply.tryDispatchAcpReplyHook.mockImplementationOnce(async () => {
      await resume.promise;
      throw failure;
    });
    const operation = host.run(() => tryDispatchAcpReplyHook(event, context));
    const rejected = expect(operation).rejects.toBe(failure);
    const closed = host.close();
    resume.resolve();
    await rejected;
    await closed;
  });

  it("retains real shared-state admission across suspension and expires it after settlement", async () => {
    const { host, reply } = makeOwner();
    const resume = createDeferredCore();
    const releaseLateCall = createDeferredCore();
    let inherited: Promise<unknown> | undefined;
    const body = vi.fn(async () => ({ handled: true, ...result }));
    const unexpected = vi.fn(async () => undefined);
    reply.tryDispatchAcpReplyHook.mockImplementationOnce(async () => {
      // Capture a descendant of the accepted operation, not just the ambient host.
      inherited = releaseLateCall.promise.then(() => host.trackSharedStateWork(unexpected));
      await resume.promise;
      return host.trackSharedStateWork(body);
    });
    const operation = host.run(() => tryDispatchAcpReplyHook(event, context));
    const closed = host.close();
    try {
      expect(() => host.assertSharedStateAdmission()).toThrow("shared-state admission is closed");
      resume.resolve();
      await expect(operation).resolves.toEqual({ handled: true, ...result });
      await closed;
      expect(body).toHaveBeenCalledOnce();
      expect(inherited).toBeDefined();
      const refused = expect(inherited).rejects.toThrow("shared-state admission is closed");
      releaseLateCall.resolve();
      await refused;
      expect(unexpected).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      releaseLateCall.resolve();
      await Promise.allSettled([operation, closed, inherited]);
    }
  });

  it.each([dispatchReplyWithBufferedBlockDispatcher, dispatchReplyWithDispatcher])(
    "strips plugin event custody before host provider dispatch",
    async (dispatch) => {
      const { host, reply } = makeOwner();
      const forbidden = vi.fn();
      const replyOptions = {
        disableTools: true,
        internalEventExecution: { assertCurrent: forbidden, onStarted: forbidden },
        onReplyOperationOwned: forbidden,
      };
      const params = { ...providerParams, replyOptions };
      try {
        await host.run(() => dispatch(params));
        const calls = [
          ...reply.dispatchReplyWithBufferedBlockDispatcher.mock.calls,
          ...reply.dispatchReplyWithDispatcher.mock.calls,
        ];
        expect(calls).toHaveLength(1);
        expect(calls[0]?.[0].replyOptions).toEqual({ disableTools: true });
        expect(replyOptions.onReplyOperationOwned).toBe(forbidden);
        expect(forbidden).not.toHaveBeenCalled();
      } finally {
        await host.close();
      }
    },
  );
});
