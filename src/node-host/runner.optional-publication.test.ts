import { setImmediate } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { GatewayClientRequestError, type GatewayClientOptions } from "../gateway/client.js";
import { NODE_RUNNER_INVENTORY_UPDATE_METHOD } from "../infra/node-runner-inventory.js";
import { mocks, resetRunnerTestState, withReadyNodeHost } from "./runner.test-support.js";

const NODE_PLUGIN_TOOLS_UPDATE_METHOD = "node.pluginTools.update";
const NODE_SKILLS_UPDATE_METHOD = "node.skills.update";
const optionalMethods = [
  NODE_PLUGIN_TOOLS_UPDATE_METHOD,
  NODE_SKILLS_UPDATE_METHOD,
  NODE_RUNNER_INVENTORY_UPDATE_METHOD,
];
type CapturedClient = (typeof mocks.capturedGatewayClients)[number];

function getPublications(client: CapturedClient, method = NODE_PLUGIN_TOOLS_UPDATE_METHOD) {
  return client.request.mock.calls.filter(([calledMethod]) => calledMethod === method);
}

function receiveHello(options: GatewayClientOptions | undefined, protocol = 4) {
  options?.onHelloOk?.({
    protocol,
    features: { methods: [], events: [] },
  } as unknown as Parameters<NonNullable<GatewayClientOptions["onHelloOk"]>>[0]);
}

const settlePublications = () => setImmediate();

const expectPublications = (client: CapturedClient, count: number) =>
  vi.waitFor(() => expect(getPublications(client)).toHaveLength(count));

function changeTools(tools: typeof mocks.nodePluginTools) {
  mocks.nodePluginTools = tools;
  mocks.availabilityChanged?.();
}

async function beginPublication(
  client: CapturedClient,
  options: GatewayClientOptions,
  ...responses: Promise<unknown>[]
) {
  queuePluginResponses(client, ...responses);
  receiveHello(options);
  await expectPublications(client, 1);
}

function queuePluginResponses(client: CapturedClient, ...responses: Promise<unknown>[]) {
  client.request.mockImplementation((method) =>
    method === NODE_PLUGIN_TOOLS_UPDATE_METHOD
      ? (responses.shift() ?? Promise.resolve({}))
      : Promise.resolve({}),
  );
}

function rejectPublications(client: CapturedClient, message: string, methods = optionalMethods) {
  client.request.mockImplementation(async (method) => {
    if (methods.includes(method)) {
      throw new GatewayClientRequestError({
        code: "INVALID_REQUEST",
        message: message.replace("$method", method),
      });
    }
    return {};
  });
}

function enableSkills() {
  mocks.nodeSkillDescriptors = [
    {
      name: "release-helper",
      description: "Prepare a release",
      content: "---\nname: release-helper\ndescription: Prepare a release\n---\n",
    },
  ];
}

describe("runNodeHost connection and optional publications", () => {
  beforeEach(resetRunnerTestState);
  afterEach(() => vi.restoreAllMocks());

  it("exits after three identical permanent Gateway upgrade rejections", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const rejection = new GatewayClientRequestError({
        code: "UNAVAILABLE",
        message: "gateway rejected websocket upgrade (HTTP 403)",
        details: {
          reason: "websocket-upgrade-rejected",
          httpStatus: 403,
          gatewayErrorType: "proxy_attribution_required",
          gatewayErrorMessage: "Configure gateway.trustedProxies narrowly",
        },
      });
      options?.onConnectError?.(rejection);
      options?.onConnectError?.(rejection);
      expect(client.stopAndWait).not.toHaveBeenCalled();
      options?.onConnectError?.(rejection);
      await vi.waitFor(() => expect(process.exitCode).toBe(1));
      expect(client.stopAndWait).toHaveBeenCalledOnce();
      expect(mocks.closeMcpManager).toHaveBeenCalledOnce();
      expect(stderr).toHaveBeenCalledWith(
        "node host gateway permanently rejected connection (proxy_attribution_required): Configure gateway.trustedProxies narrowly; exiting\n",
      );
    });
  });

  it("keeps retrying transient upgrade failures and resets permanent rejection streaks", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const permanentRejection = new GatewayClientRequestError({
        code: "UNAVAILABLE",
        details: {
          reason: "websocket-upgrade-rejected",
          httpStatus: 403,
          gatewayErrorType: "proxy_attribution_required",
        },
      });
      const rejectTwice = () => {
        options?.onConnectError?.(permanentRejection);
        options?.onConnectError?.(permanentRejection);
      };
      const transientErrors = [
        new Error("connect ECONNRESET"),
        ...[
          { httpStatus: 429, gatewayErrorType: "rate_limited" },
          { httpStatus: 503, gatewayErrorType: "proxy_attribution_required" },
          { httpStatus: 403 },
          { httpStatus: 403, gatewayErrorType: "another_rejection" },
        ].map(
          (details) =>
            new GatewayClientRequestError({
              code: "UNAVAILABLE",
              details: { reason: "websocket-upgrade-rejected", ...details },
            }),
        ),
      ];
      for (const transientError of transientErrors) {
        rejectTwice();
        options?.onConnectError?.(transientError);
        expect(client.stopAndWait).not.toHaveBeenCalled();
      }
      rejectTwice();
      receiveHello(options);
      rejectTwice();
      expect(client.stopAndWait).not.toHaveBeenCalled();
      expect(stderr).not.toHaveBeenCalledWith(expect.stringContaining("permanently rejected"));
    });
  });

  it("treats exact v3 authorization failures as unsupported optional publications", async () => {
    enableSkills();
    await withReadyNodeHost(async ({ client, options }) => {
      rejectPublications(client, "unauthorized role: node");
      receiveHello(options, 3);
      await vi.waitFor(() => expect(getPublications(client)).toHaveLength(1));
      mocks.availabilityChanged?.();
      await settlePublications();
      for (const method of optionalMethods) {
        expect(getPublications(client, method)).toHaveLength(1);
      }
      client.request.mockResolvedValue({});
      options?.onClose?.(1000, "legacy gateway closed");
      receiveHello(options);
      await vi.waitFor(() => {
        for (const method of optionalMethods) {
          expect(getPublications(client, method)).toHaveLength(2);
        }
      });
    });
  });

  it("fails closed without flooding on exact v4 authorization failures", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      rejectPublications(client, "unauthorized role: node", [NODE_PLUGIN_TOOLS_UPDATE_METHOD]);
      receiveHello(options);
      await vi.waitFor(() => expect(getPublications(client)).toHaveLength(1));
      for (let index = 0; index < 10; index += 1) {
        mocks.availabilityChanged?.();
      }
      await settlePublications();
      expect(getPublications(client)).toHaveLength(1);
      changeTools([]);
      await expectPublications(client, 2);
      mocks.availabilityChanged?.();
      await settlePublications();
      expect(getPublications(client)).toHaveLength(2);
    });
  });

  it("publishes the latest inventory queued during a failed optional publication", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initial = createDeferred<unknown>();
      queuePluginResponses(client, initial.promise);
      receiveHello(options, 3);
      await vi.waitFor(() => expect(getPublications(client)).toHaveLength(1));
      changeTools([]);
      initial.reject(new Error("temporary publish failure"));
      await vi.waitFor(() =>
        expect(client.request).toHaveBeenCalledWith(NODE_PLUGIN_TOOLS_UPDATE_METHOD, { tools: [] }),
      );
    });
  });

  it("deduplicates inventory when the desired value returns to the in-flight value", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initialPluginTools = [...mocks.nodePluginTools];
      const initial = createDeferred<unknown>();
      await beginPublication(client, options, initial.promise);
      changeTools([]);
      changeTools(initialPluginTools);
      initial.resolve({});
      await settlePublications();
      await settlePublications();
      expect(getPublications(client)).toEqual([
        [NODE_PLUGIN_TOOLS_UPDATE_METHOD, { tools: initialPluginTools }],
      ]);
      mocks.availabilityChanged?.();
      await settlePublications();
      expect(getPublications(client)).toHaveLength(1);
    });
  });

  it("preserves retry backoff across duplicate inventory events", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const failures = Array.from({ length: 3 }, () => createDeferred<unknown>());
      await beginPublication(client, options, ...failures.map(({ promise }) => promise));
      vi.useFakeTimers();
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
      try {
        const flushPublicationSettlement = async () => {
          for (let index = 0; index < 10; index += 1) {
            await Promise.resolve();
          }
        };
        for (const [index, failure] of failures.entries()) {
          mocks.availabilityChanged?.();
          failure.reject(new Error("temporary publish failure"));
          await flushPublicationSettlement();
          expect(getPublications(client)).toHaveLength(index + 1);
          expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 250 * 2 ** index);
          await vi.runOnlyPendingTimersAsync();
          await flushPublicationSettlement();
          expect(getPublications(client)).toHaveLength(index + 2);
        }
      } finally {
        setTimeoutSpy.mockRestore();
        vi.useRealTimers();
      }
    });
  });

  it("republishes an acknowledged value after an ambiguous different-value failure", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initialPluginTools = [...mocks.nodePluginTools];
      const changed = createDeferred<unknown>();
      await beginPublication(client, options, Promise.resolve({}), changed.promise);
      await settlePublications();
      changeTools([]);
      await expectPublications(client, 2);
      changed.reject(new Error("publication outcome unknown"));
      await settlePublications();
      changeTools(initialPluginTools);
      await vi.waitFor(() => {
        const publications = getPublications(client);
        expect(publications.length).toBeGreaterThanOrEqual(3);
        expect(publications.at(-1)?.[1]).toEqual({ tools: initialPluginTools });
      });
    });
  });

  it("retains the latest inventory when it returns to a previously rejected value", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initialPluginTools = [...mocks.nodePluginTools];
      const initial = createDeferred<unknown>();
      const second = createDeferred<unknown>();
      await beginPublication(client, options, initial.promise, second.promise);
      changeTools([]);
      initial.reject(
        new GatewayClientRequestError({
          code: "INVALID_REQUEST",
          message: "temporary validation failure",
        }),
      );
      await expectPublications(client, 2);
      changeTools(initialPluginTools);
      second.resolve({});
      await vi.waitFor(() => {
        const publications = getPublications(client);
        expect(publications).toHaveLength(3);
        expect(publications.at(-1)?.[1]).toEqual({ tools: initialPluginTools });
      });
    });
  });

  it("retires in-flight inventory before manifest reconnect", async () => {
    await withReadyNodeHost(async ({ client, options }) => {
      const initial = createDeferred<unknown>();
      queuePluginResponses(client, initial.promise);
      receiveHello(options, 3);
      await vi.waitFor(() => expect(getPublications(client)).toHaveLength(1));
      await settlePublications();
      Object.assign(mocks, { nodePluginTools: [], nodeHostCaps: ["canvas"] });
      mocks.availabilityChanged?.();
      initial.resolve({});
      await settlePublications();
      expect(getPublications(client)).toHaveLength(1);
      receiveHello(options, 3);
      await vi.waitFor(() => expect(getPublications(client)).toHaveLength(2));
      expect(client.request).toHaveBeenLastCalledWith(NODE_PLUGIN_TOOLS_UPDATE_METHOD, {
        tools: [],
      });
    });
  });
});
