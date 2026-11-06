import { afterEach, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { cronRpc } from "./cron-rpc.test-support.ts";
import { getElement, selectSegmented } from "./view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("blocks saves until discovery and schema validation finish, then submits the event schedule", async () => {
  const catalog = createDeferredCore<unknown>();
  const request = cronRpc({
    "mcp.events.list": () => catalog.promise,
    "cron.add": () => ({ id: "created-event" }),
  });
  const gateway = createGateway(createTestGatewayClient(request), true);
  gateway.emitSnapshot({
    hello: {
      ...operatorHello(["operator.admin"]),
      features: { methods: ["mcp.events.list", "mcp-events.status"], events: [] },
    },
  });
  const context = createContext(gateway);
  context.runtimeConfig.ensureLoaded = vi.fn(async () => undefined);
  const page = createPage(context, { render: true });
  const button = (id: string) => getElement(page, `[data-test-id="cron-${id}"]`, HTMLButtonElement);
  expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
  button("new-task").click();
  await page.settle();
  selectSegmented(getElement(page, '[data-test-id="cron-schedule-kind-event"]', HTMLElement));
  page.patchForm({
    name: "Deployment alerts",
    payloadText: "Summarize the deployment.",
    eventServer: "deployments",
  });
  page.patchForm({ eventName: "deployment.changed" });
  page.submitForm();
  expect(request.mock.calls.some(([method]) => method === "cron.add")).toBe(false);
  expect(context.runtimeConfig.ensureLoaded).toHaveBeenCalled();

  catalog.resolve({
    serverName: "deployments",
    events: [
      {
        name: "deployment.changed",
        inputSchema: {
          type: "object",
          properties: { project: { type: "string" } },
          required: ["project"],
          additionalProperties: false,
        },
        payloadSchema: true,
      },
    ],
  });
  await waitForCronPage(() =>
    expect(page.querySelector("#cron-error-eventArguments")?.textContent).toContain("input schema"),
  );
  expect(button("submit").disabled).toBe(true);
  expect(page.querySelector('[data-test-id="cron-submit-run"]')).toBeNull();
  const args = getElement(page, "#cron-event-arguments", HTMLTextAreaElement);
  args.value = '{"project":"website"}';
  args.dispatchEvent(new Event("input", { bubbles: true }));
  await page.settle();
  const submit = button("submit");
  expect(submit.disabled).toBe(false);
  submit.click();
  await waitForCronPage(() =>
    expect(request).toHaveBeenCalledWith(
      "cron.add",
      expect.objectContaining({
        schedule: {
          kind: "event",
          source: "mcp-events",
          options: {
            server: "deployments",
            name: "deployment.changed",
            arguments: { project: "website" },
          },
        },
        payload: { kind: "agentTurn", message: "Summarize the deployment." },
      }),
    ),
  );
  await waitForCronPage(() => expect(page.cron.cronCreateOpen).toBe(false));
  page.remove();
});
