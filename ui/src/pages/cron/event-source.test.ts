import { expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { buildCronSchedule, hasUnchangedCronSchedule } from "../../lib/cron/form-schedule.ts";
import { validateCronForm } from "../../lib/cron/form.ts";
import { createInitialCronState, startCronEdit } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import { attribute, fillInput, testId } from "./cron-assertions.test-support.ts";
import * as events from "./event-source.ts";
import { createCronViewJob, renderCronView, scheduledJob } from "./view.test-support.ts";

const definition: events.McpEventDefinition = {
  name: "deployment.changed",
  description: "Deployment status changed.",
  payloadSchema: true,
  inputSchema: {
    type: "object",
    properties: { project: { type: "string" } },
    required: ["project"],
  },
};
const form = {
  ...createInitialCronState().cronForm,
  name: "Deployment alerts",
  payloadText: "Summarize the deployment.",
  scheduleKind: "event" as const,
  eventServer: "deployments",
  eventName: definition.name,
  eventArguments: '{"project":"website"}',
};
const source = {
  available: true,
  loading: false,
  error: null,
  events: [definition],
  servers: ["deployments"],
  subscriptions: [],
  statusError: null,
  onRefresh: vi.fn(),
};
function eventCatalog(request: Parameters<typeof createTestGatewayClient>[0]) {
  const controller = events.createCronEventSource(vi.fn());
  const scope = {
    client: createTestGatewayClient(request),
    agentId: "main",
    serverName: "server",
    isCurrent: () => true,
  };
  return { controller, scope };
}

it("resets dependent selection only when its server or event changes", () => {
  const patch = events.resolveCronEventPatch.bind(null, form);
  const server = Object.freeze({ eventServer: "other", name: "Renamed" });
  expect(patch(server)).toEqual({ ...server, eventName: "", eventArguments: "{}" });
  const event = Object.freeze({ eventName: "release.published" });
  expect(patch(event)).toEqual({ ...event, eventArguments: "{}" });
  const unchanged = { eventServer: form.eventServer, eventName: form.eventName, name: "Renamed" };
  expect(patch(unchanged)).toEqual(unchanged);
});

it("round-trips event options through the existing form without synthesizing a timed schedule", () => {
  const schedule = buildCronSchedule(form);
  expect(schedule).toEqual({
    kind: "event",
    source: "mcp-events",
    options: { server: "deployments", name: definition.name, arguments: { project: "website" } },
  });
  const state = createInitialCronState();
  const job = scheduledJob("event-job", { schedule });
  startCronEdit(state, job);
  expect(validateCronForm(state.cronForm)).toEqual({});
  const restored = state.cronForm;
  expect(hasUnchangedCronSchedule(restored, job)).toBe(true);
  expect(hasUnchangedCronSchedule({ ...restored, eventArguments: form.eventArguments }, job)).toBe(
    true,
  );
  expect(hasUnchangedCronSchedule({ ...restored, eventServer: "different" }, job)).toBe(false);
  expect(buildCronSchedule(restored)).toEqual(schedule);
});

it("validates JSON and the selected event schema before allowing a save", () => {
  expect(events.validateCronEventSelection(form, source)).toEqual({});
  expect({
    payload: validateCronForm({ ...form, payloadKind: "systemEvent", sessionTarget: "main" }),
    schema: events.validateCronEventSelection({ ...form, eventArguments: "{}" }, source),
    json: validateCronForm({ ...form, eventArguments: "[]" }),
  }).toMatchObject({
    payload: { payloadText: "cron.events.agentTurnRequired" },
    schema: { eventArguments: "cron.events.eventArgumentsSchema" },
    json: { eventArguments: "cron.events.eventArgumentsInvalid" },
  });
  for (const unavailable of [{ loading: true }, { events: [] }, { available: false }]) {
    expect(events.validateCronEventSelection(form, { ...source, ...unavailable })).toHaveProperty(
      "eventName",
    );
  }
});

it("loads all catalog pages and rejects late results from the retired server", async () => {
  const pending = createDeferredCore<unknown>();
  const released = Object.freeze({ ...definition, name: "release.published" });
  const request = vi
    .fn()
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ serverName: "new", events: [definition], nextCursor: "page-2" })
    .mockResolvedValueOnce({ serverName: "new", events: [released] });
  const { controller, scope } = eventCatalog(request);
  const old = controller.load({ ...scope, serverName: "old" });
  await controller.load({ ...scope, agentId: "other", serverName: "new" });
  pending.resolve({ serverName: "old", events: [] });
  await old;
  expect(controller.events.map((event) => event.name)).toEqual([definition.name, released.name]);
  expect(request).toHaveBeenLastCalledWith("mcp.events.list", {
    agentId: "other",
    serverName: "new",
    cursor: "page-2",
  });
  expect(controller.error).toBeNull();
});

it("retains current diagnostics when the catalog fails and ignores retired source identities", async () => {
  const current = Object.freeze({ jobId: "job", sourceIdentity: "new", status: "pending" });
  const request = vi.fn(async (method: string) => {
    if (method === "mcp.events.list") {
      throw new Error("catalog offline");
    }
    return {
      subscriptions: [{ jobId: "job", sourceIdentity: "old", status: "active" }, current],
    };
  });
  const { controller, scope } = eventCatalog(request);
  await controller.load({ ...scope, jobId: "job", sourceIdentity: "new" });
  expect(controller.error).toContain("catalog offline");
  expect(controller.subscriptions).toEqual([current]);
  expect(controller.loading).toBe(false);
});

it("renders the real event editor, schema error, and subscription replay gap", async () => {
  const onFormChange = vi.fn();
  const job = createCronViewJob("event-job", { schedule: buildCronSchedule(form), state: {} });
  const container = await renderCronView({
    form,
    editingJob: job,
    onFormChange,
    fieldErrors: {
      eventServer: "cron.events.eventServerRequired",
      eventName: "cron.events.eventNameRequired",
      eventArguments: "cron.events.eventArgumentsSchema",
    },
    eventSource: {
      ...source,
      subscriptions: [
        {
          jobId: job.id,
          sourceIdentity: "revision",
          serverName: form.eventServer,
          name: form.eventName,
          status: "active",
          truncated: true,
        },
      ],
    },
  });
  expect(attribute(container, "#cron-event-arguments", "aria-invalid")).toBe("true");
  const args = fillInput(container, "#cron-event-arguments", '{"project":"api"}');
  expect(onFormChange).toHaveBeenCalledWith({ eventArguments: args.value });
  expect(container.textContent).toContain("Replay gap:");
  expect(container.querySelector("#cron-cron-expr")).toBeNull();
  expect(container.querySelector(testId("cron-submit-run"))).toBeNull();
  expect(container.textContent).not.toContain("Delete after run");
  for (const field of ["eventServer", "eventName"]) {
    expect(container.querySelector(`#cron-error-${field}`)).not.toBeNull();
  }
});
