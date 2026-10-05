import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { createInitialCronState } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { createContext, createGateway, operatorHello } from "./cron-page.test-support.ts";
import { CronEventEditorController } from "./event-editor.ts";

// No mounted page or timer is needed: the controller receives the same live
// agent-selection owner that hydration updates before Lit's next render.
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
    const editor = new CronEventEditorController({
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
