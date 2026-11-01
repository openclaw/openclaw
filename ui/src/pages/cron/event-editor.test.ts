import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createContext, createGateway, operatorHello } from "./cron-page.test-support.tsx";
import { createCronEventEditor } from "./event-editor.ts";
import { createCronViewJob } from "./view.test-support.ts";

function setup(request: Parameters<typeof createTestGatewayClient>[0]) {
  const client = createTestGatewayClient(request);
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
  const connection = { client, epoch: 1 };
  const ready = createDeferredCore();
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
  return { client, context, cron, editor, ready };
}

function observeRead(client: ReturnType<typeof createTestGatewayClient>, held: () => boolean) {
  const finished = createDeferredCore();
  const request = client.request.bind(client);
  client.request = <T>(...args: Parameters<typeof client.request>): Promise<T> => {
    const result = request<T>(...args);
    if (args[0] === "mcp.events.list" && held()) {
      void result.then(() => finished.resolve());
    }
    return result;
  };
  return finished.promise;
}

it("rejects an old catalog before a preserved editor synchronizes its hydrated agent", async () => {
  const response = createDeferredCore<unknown>();
  const definition = { name: "changed", inputSchema: true, payloadSchema: true };
  let calls = 0;
  const { client, context, cron, editor, ready } = setup(() => {
    if (++calls === 1) {
      return response.promise;
    }
    return { serverName: "reviews", events: [definition] };
  });
  cron.cronCreateOpen = true;
  cron.cronForm = {
    ...cron.cronForm,
    scheduleKind: "event",
    eventServer: "reviews",
  };
  // Resolving the witness queues the test continuation after the controller
  // resumes from this same request, so the assertion observes publication.
  const staleReadFinished = observeRead(client, () => calls === 1);
  editor.sync();
  context.agentSelection.set("other");
  response.resolve({ serverName: "reviews", events: [definition] });
  await staleReadFinished;
  expect(editor.view.events).toEqual([]);
  editor.sync();
  await ready.promise;
  expect(editor.view.events).toEqual([definition]);
  expect(calls).toBe(2);
});
it("does not read runtime config while the event editor is inactive", () => {
  const request = vi.fn(async () => ({}));
  const { context, cron, editor } = setup(request);
  const configRead = vi.fn(() => ({ configSnapshot: null }));
  Object.defineProperty(context.runtimeConfig, "state", { get: configRead });
  for (const createOpen of [false, true]) {
    cron.cronCreateOpen = createOpen;
    editor.sync();
    expect(editor.view.available).toBe(true);
    expect(editor.view.servers).toEqual([]);
  }
  expect(configRead).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
});
it.each(["revision", "source identity", "enabled"])(
  "rejects the held catalog when the job's %s changes",
  async (change) => {
    const response = createDeferredCore<unknown>();
    let catalogCalls = 0;
    const definition = { name: "changed", inputSchema: false, payloadSchema: true };
    const { client, cron, editor, ready } = setup((method) => {
      if (method === "mcp-events.status") {
        return { subscriptions: [] };
      }
      catalogCalls += 1;
      return catalogCalls === 1
        ? response.promise
        : { serverName: "reviews", events: [definition] };
    });
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
    const oldReadFinished = observeRead(client, () => catalogCalls === 1);
    editor.sync();
    if (change === "revision") {
      job.configRevision = "definition-two";
    } else if (change === "source identity") {
      job.state.sourceIdentity = "source-two";
    } else {
      job.enabled = false;
    }
    response.resolve({ serverName: "reviews", events: [{ ...definition, inputSchema: true }] });
    await oldReadFinished;
    expect(editor.view.events).toEqual([]);
    editor.sync();
    await ready.promise;
    expect(editor.view.events).toEqual([definition]);
    expect(catalogCalls).toBe(2);
  },
);
