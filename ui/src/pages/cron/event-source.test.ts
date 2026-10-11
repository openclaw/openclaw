import { describe, expect, it, vi } from "vitest";
import { createDeferredCore } from "../../../../src/shared/deferred.ts";
import { buildCronSchedule, hasUnchangedCronSchedule } from "../../lib/cron/form-schedule.ts";
import { createInitialCronState, startCronEdit, validateCronForm } from "../../lib/cron/index.ts";
import { createTestGatewayClient } from "../../test-helpers/gateway-client.ts";
import {
  CronEventSourceController,
  resolveCronEventPatch,
  validateCronEventSelection,
  type McpEventDefinition,
} from "./event-source.ts";
import { createCronViewJob, renderCronView } from "./view.test-support.ts";

const definition: McpEventDefinition = {
  name: "deployment.changed",
  delivery: ["webhook"],
  description: "Deployment status changed.",
  payloadSchema: true,
  inputSchema: {
    type: "object",
    properties: { project: { type: "string", minLength: 1 } },
    required: ["project"],
    additionalProperties: false,
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

describe("Automation event source", () => {
  it("resets dependent selection only when its server or event changes", () => {
    expect(resolveCronEventPatch(form, { eventServer: "other", name: "Renamed" })).toEqual({
      eventServer: "other",
      name: "Renamed",
      eventName: "",
      eventArguments: "{}",
    });
    expect(resolveCronEventPatch(form, { eventName: "release.published" })).toEqual({
      eventName: "release.published",
      eventArguments: "{}",
    });
    const unchanged = { eventServer: form.eventServer, eventName: form.eventName, name: "Renamed" };
    expect(resolveCronEventPatch(form, unchanged)).toEqual(unchanged);
  });

  it("round-trips event options through the existing form without synthesizing a timed schedule", () => {
    const schedule = buildCronSchedule(form);
    expect(schedule).toEqual({
      kind: "event",
      source: "mcp-events",
      options: { server: "deployments", name: definition.name, arguments: { project: "website" } },
    });
    const state = createInitialCronState();
    const job = createCronViewJob("event-job", {
      schedule,
      state: {},
      payload: { kind: "agentTurn", message: form.payloadText },
      sessionTarget: "isolated",
    });
    startCronEdit(state, job);
    expect(validateCronForm(state.cronForm)).toEqual({});
    expect(hasUnchangedCronSchedule(state.cronForm, job)).toBe(true);
    expect(
      hasUnchangedCronSchedule({ ...state.cronForm, eventArguments: form.eventArguments }, job),
    ).toBe(true);
    expect(hasUnchangedCronSchedule({ ...state.cronForm, eventServer: "different" }, job)).toBe(
      false,
    );
    expect(buildCronSchedule(state.cronForm)).toEqual(schedule);
  });

  it("validates JSON and the selected event schema before allowing a save", () => {
    expect(validateCronEventSelection(form, source)).toEqual({});
    expect(
      validateCronForm({ ...form, payloadKind: "systemEvent", sessionTarget: "main" }),
    ).toHaveProperty("payloadText", "cron.events.agentTurnRequired");
    expect(validateCronEventSelection({ ...form, eventArguments: "{}" }, source)).toHaveProperty(
      "eventArguments",
      "cron.events.eventArgumentsSchema",
    );
    expect(validateCronForm({ ...form, eventArguments: "[]" })).toHaveProperty(
      "eventArguments",
      "cron.events.eventArgumentsInvalid",
    );
    expect(validateCronEventSelection(form, { ...source, loading: true })).toHaveProperty(
      "eventName",
    );
    expect(validateCronEventSelection(form, { ...source, events: [] })).toHaveProperty("eventName");
    expect(validateCronEventSelection(form, { ...source, available: false })).toHaveProperty(
      "eventName",
    );
  });

  it("loads all catalog pages and rejects late results from the retired server", async () => {
    const pending = createDeferredCore<unknown>();
    const request = vi
      .fn()
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce({ serverName: "new", events: [definition], nextCursor: "page-2" })
      .mockResolvedValueOnce({
        serverName: "new",
        events: [{ ...definition, name: "release.published" }],
      });
    const client = createTestGatewayClient(request);
    const controller = new CronEventSourceController(vi.fn());
    const old = controller.load({
      client,
      agentId: "main",
      serverName: "old",
      isCurrent: () => true,
    });
    await controller.load({ client, agentId: "other", serverName: "new", isCurrent: () => true });
    pending.resolve({ serverName: "old", events: [] });
    await old;
    expect(controller.events.map((event) => event.name)).toEqual([
      definition.name,
      "release.published",
    ]);
    expect(request).toHaveBeenLastCalledWith("mcp.events.list", {
      agentId: "other",
      serverName: "new",
      cursor: "page-2",
    });
    expect(controller.error).toBeNull();
  });

  it("retains current diagnostics when the catalog fails and ignores retired source identities", async () => {
    const request = vi.fn(async (method: string) => {
      if (method === "mcp.events.list") {
        throw new Error("catalog offline");
      }
      return {
        subscriptions: [
          { jobId: "job", sourceIdentity: "old", status: "active" },
          { jobId: "job", sourceIdentity: "new", status: "pending" },
        ],
      };
    });
    const controller = new CronEventSourceController(vi.fn());
    await controller.load({
      client: createTestGatewayClient(request),
      agentId: "main",
      serverName: "server",
      jobId: "job",
      sourceIdentity: "new",
      isCurrent: () => true,
    });
    expect(controller.error).toContain("catalog offline");
    expect(controller.subscriptions).toEqual([
      { jobId: "job", sourceIdentity: "new", status: "pending" },
    ]);
    expect(controller.loading).toBe(false);
  });

  it("renders the real event editor, schema error, and subscription replay gap", () => {
    const onFormChange = vi.fn();
    const job = createCronViewJob("event-job", { schedule: buildCronSchedule(form), state: {} });
    const container = renderCronView({
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
    const args = container.querySelector<HTMLTextAreaElement>("#cron-event-arguments")!;
    expect(args.getAttribute("aria-invalid")).toBe("true");
    args.value = '{"project":"api"}';
    args.dispatchEvent(new Event("input"));
    expect(onFormChange).toHaveBeenCalledWith({ eventArguments: args.value });
    expect(container.textContent).toContain("Replay gap:");
    expect(container.querySelector("#cron-cron-expr")).toBeNull();
    expect(container.querySelector('[data-test-id="cron-submit-run"]')).toBeNull();
    expect(container.textContent).not.toContain("Delete after run");
    for (const field of ["eventServer", "eventName"]) {
      expect(container.querySelector(`#cron-error-${field}`)).not.toBeNull();
    }
  });
});
