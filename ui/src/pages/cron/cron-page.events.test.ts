import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  createContext,
  createGateway,
  createPage,
  createRequest,
  operatorHello,
  waitForCronPage,
} from "./cron-page.test-support.tsx";
import { getElement, selectSegmented } from "./view.test-support.ts";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

// Real page/controller composition, fixed Gateway I/O: catches a renderer cutover
// that leaves discovery or schema validation on the retired Lit page.
describe("event automation authoring", () => {
  it("blocks saves until discovery and schema validation finish, then submits the event schedule", async () => {
    const catalog = createDeferredCore<unknown>();
    const fallback = createRequest();
    const request = vi.fn(async (method: string) => {
      if (method === "mcp.events.list") {
        return catalog.promise;
      }
      if (method === "cron.add") {
        return { id: "created-event" };
      }
      return fallback(method);
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
    expect(context.runtimeConfig.ensureLoaded).not.toHaveBeenCalled();
    getElement(page, '[data-test-id="cron-new-task"]', HTMLButtonElement).click();
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
      expect(page.querySelector("#cron-error-eventArguments")?.textContent).toContain(
        "input schema",
      ),
    );
    expect(getElement(page, '[data-test-id="cron-submit"]', HTMLButtonElement).disabled).toBe(true);
    expect(page.querySelector('[data-test-id="cron-submit-run"]')).toBeNull();
    const args = getElement(page, "#cron-event-arguments", HTMLTextAreaElement);
    args.value = '{"project":"website"}';
    args.dispatchEvent(new Event("input", { bubbles: true }));
    await page.settle();
    const submit = getElement(page, '[data-test-id="cron-submit"]', HTMLButtonElement);
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
});
