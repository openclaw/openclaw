import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createContext, createGateway, operatorHello } from "./cron-page.test-support.tsx";
import { createCronEventEditor } from "./event-editor.ts";
import { createCronViewJob } from "./view.test-support.ts";

// No mounted page or timer is needed: the controller receives the same live
// agent-selection owner that hydration updates before the next render.
describe("event editor scope hydration", () => {
  it("rejects an old catalog before a preserved editor synchronizes its hydrated agent", async () => {
    const response = createDeferredCore<unknown>();
    const staleReadFinished = createDeferredCore();
    const ready = createDeferredCore();
    const definition = { name: "changed", inputSchema: true, payloadSchema: true };
    let calls = 0;
    const client = createTestGatewayClient(() => {
      if (++calls === 1) {
        return response.promise;
      }
      return { serverName: "reviews", events: [definition] };
    });
    const gateway = createGateway(client, true);
    gateway.emitSnapshot({
      hello: {
        ...operatorHello(["operator.admin"]),
        features: { methods: ["mcp.events.list", "mcp-events.status"], events: [] },
      },
    });
    const context = createContext(gateway);
    context.runtimeConfig.ensureLoaded = vi.fn(async () => undefined);
    const cron = createInitialCronState({ client, connected: true });
    cron.cronCreateOpen = true;
    cron.cronForm = {
      ...cron.cronForm,
      scheduleKind: "event",
      eventServer: "reviews",
    };
    const connection = { client, epoch: 1 };
    const editor = createCronEventEditor({
      currentCronState: () => cron,
      context: () => context,
      canManage: () => true,
      isConnected: () => true,
      captureConnection: () => connection,
      isCurrentConnection: (scope) => scope === connection,
      notify: () => {
        if (!editor.view.loading) {
          ready.resolve();
        }
      },
    });
    // Resolving the witness queues the test continuation after the controller
    // resumes from this same request, so the assertion observes publication.
    const request = client.request.bind(client);
    client.request = <T>(...args: Parameters<typeof client.request>): Promise<T> => {
      const result = request<T>(...args);
      if (calls === 1) {
        void result.then(() => staleReadFinished.resolve());
      }
      return result;
    };
    editor.sync();
    context.agentSelection.set("other");
    response.resolve({ serverName: "reviews", events: [definition] });
    await staleReadFinished.promise;
    expect(editor.view.events).toEqual([]);
    editor.sync();
    await ready.promise;
    expect(editor.view.events).toEqual([definition]);
    expect(calls).toBe(2);
  });
});

describe("event editor discovery lifetime", () => {
  it("does not read runtime config while the event editor is inactive", () => {
    const request = vi.fn(async () => ({}));
    const client = createTestGatewayClient(request);
    const gateway = createGateway(client, true);
    gateway.emitSnapshot({
      hello: {
        ...operatorHello(["operator.admin"]),
        features: { methods: ["mcp.events.list", "mcp-events.status"], events: [] },
      },
    });
    const context = createContext(gateway);
    const configRead = vi.fn(() => ({ configSnapshot: null }));
    Object.defineProperty(context.runtimeConfig, "state", { get: configRead });
    const cron = createInitialCronState({ client, connected: true });
    const connection = { client, epoch: 1 };
    const editor = createCronEventEditor({
      currentCronState: () => cron,
      context: () => context,
      canManage: () => true,
      isConnected: () => true,
      captureConnection: () => connection,
      isCurrentConnection: (scope) => scope === connection,
      notify: () => undefined,
    });
    for (const createOpen of [false, true]) {
      cron.cronCreateOpen = createOpen;
      editor.sync();
      expect(editor.view.available).toBe(true);
      expect(editor.view.servers).toEqual([]);
    }
    expect(configRead).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("event definition replacement", () => {
  it.each(["revision", "source identity", "enabled"])(
    "rejects the held catalog when the job's %s changes",
    async (change) => {
      const response = createDeferredCore<unknown>();
      const oldReadFinished = createDeferredCore();
      const ready = createDeferredCore();
      let catalogCalls = 0;
      const definition = { name: "changed", inputSchema: false, payloadSchema: true };
      const client = createTestGatewayClient((method) => {
        if (method === "mcp-events.status") {
          return { subscriptions: [] };
        }
        catalogCalls += 1;
        return catalogCalls === 1
          ? response.promise
          : { serverName: "reviews", events: [definition] };
      });
      const gateway = createGateway(client, true);
      gateway.emitSnapshot({
        hello: {
          ...operatorHello(["operator.admin"]),
          features: { methods: ["mcp.events.list", "mcp-events.status"], events: [] },
        },
      });
      const context = createContext(gateway);
      context.runtimeConfig.ensureLoaded = vi.fn(async () => undefined);
      const cron = createInitialCronState({ client, connected: true });
      const job = createCronViewJob("event-job", {
        configRevision: "definition-one",
        schedule: {
          kind: "event",
          source: "mcp-events",
          options: { server: "reviews", name: "changed" },
        },
        state: { sourceIdentity: "source-one" },
      });
      cron.cronEditingJob = job;
      cron.cronForm = {
        ...cron.cronForm,
        scheduleKind: "event",
        eventServer: "reviews",
        eventName: "changed",
      };
      const connection = { client, epoch: 1 };
      const editor = createCronEventEditor({
        currentCronState: () => cron,
        context: () => context,
        canManage: () => true,
        isConnected: () => true,
        captureConnection: () => connection,
        isCurrentConnection: (scope) => scope === connection,
        notify: () => {
          if (!editor.view.loading) {
            ready.resolve();
          }
        },
      });
      const request = client.request.bind(client);
      client.request = <T>(...args: Parameters<typeof client.request>): Promise<T> => {
        const result = request<T>(...args);
        if (args[0] === "mcp.events.list" && catalogCalls === 1) {
          void result.then(() => oldReadFinished.resolve());
        }
        return result;
      };
      editor.sync();
      if (change === "revision") {
        job.configRevision = "definition-two";
      } else if (change === "source identity") {
        job.state.sourceIdentity = "source-two";
      } else {
        job.enabled = false;
      }
      response.resolve({ serverName: "reviews", events: [{ ...definition, inputSchema: true }] });
      await oldReadFinished.promise;
      expect(editor.view.events).toEqual([]);
      editor.sync();
      await ready.promise;
      expect(editor.view.events).toEqual([definition]);
      expect(catalogCalls).toBe(2);
    },
  );
});
