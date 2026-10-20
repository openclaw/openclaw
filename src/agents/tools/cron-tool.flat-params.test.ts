import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronTool } from "./cron-tool.js";
import { wrapToolWithGatewayCallerIdentity } from "./gateway-caller-context.js";
import * as gatewayModule from "./gateway.js";

const gateway = vi.fn();
const job = {
  name: "reminder",
  schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
  payload: { kind: "agentTurn", message: "work" },
};
function execute(args: Record<string, unknown>) {
  return createCronTool().execute("cron", args);
}
function expectAdd(params: Record<string, unknown>) {
  expect(gateway).toHaveBeenCalledExactlyOnceWith(
    "cron.add",
    expect.anything(),
    expect.objectContaining(params),
  );
}
function expectUpdate(id: string, patch: Record<string, unknown>, revision?: string) {
  expect(gateway.mock.calls).toEqual(
    revision
      ? [
          ["cron.get", expect.anything(), { id }],
          ["cron.update", expect.anything(), { id, expectedConfigRevision: revision, patch }],
        ]
      : [["cron.update", expect.anything(), { id, patch }]],
  );
}
function updatePatch() {
  const params = gateway.mock.calls[0]?.[2] as { patch?: Record<string, unknown> } | undefined;
  return params?.patch;
}
function update(params: Record<string, unknown>) {
  return execute({ action: "update", jobId: "job", ...params });
}

beforeEach(() => {
  const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(gateway);
  onTestFinished(() => gatewaySpy.mockRestore());
  setRuntimeConfigSnapshot({});
  gateway.mockReset().mockResolvedValue({ ok: true });
});

afterEach(clearRuntimeConfigSnapshot);

describe("cron shorthand recovery", () => {
  it.each(
    (["factory", "host-bound"] as const).flatMap((caller) =>
      (["remove", "update"] as const).flatMap((action) =>
        [false, true].map((retired) => ({ caller, action, retired })),
      ),
    ),
  )(
    "pins $action to the active $caller caller after lookup (retired=$retired)",
    async ({ caller, action, retired }) => {
      let current = true;
      let mutated = false;
      gateway.mockImplementation(async (method: string) => {
        if (method === "cron.get") {
          current = !retired;
          return { id: "watcher", configRevision: "sha256:captured" };
        }
        if (method === `cron.${action}`) {
          mutated = true;
          return { ok: true };
        }
        throw new Error(`Unexpected method: ${method}`);
      });
      const identity = {
        agentId: "main",
        sessionKey: "agent:main:watcher-control",
        receiptAuthority: () => current,
      };
      // The harness host binds the admitted caller after a plugin builds its tools.
      const tool = wrapToolWithGatewayCallerIdentity(
        createCronTool(
          caller === "factory"
            ? { agentId: identity.agentId, agentSessionKey: identity.sessionKey }
            : undefined,
        ),
        identity,
      );
      const patch = action === "update" ? { enabled: false } : undefined;
      const mutation = tool.execute("stop-watcher", {
        action,
        jobId: "watcher",
        ...(patch ? { job: patch } : {}),
      });
      if (retired) {
        await expect(mutation).rejects.toThrow("The requesting turn is no longer active.");
        expect(gateway.mock.calls).toEqual([["cron.get", expect.anything(), { id: "watcher" }]]);
      } else {
        await expect(mutation).resolves.toMatchObject({ details: { ok: true } });
        expect(gateway.mock.calls).toEqual([
          ["cron.get", expect.anything(), { id: "watcher" }],
          [
            `cron.${action}`,
            expect.anything(),
            {
              id: "watcher",
              expectedConfigRevision: "sha256:captured",
              ...(patch ? { patch } : {}),
            },
          ],
        ]);
      }
      expect(mutated).toBe(!retired);
    },
  );

  it("presents list metadata without private job content", () => {
    const presentation = getToolTerminalPresentation(createCronTool());
    if (!presentation) {
      throw new Error("expected terminal presentation");
    }
    const result = {
      content: [],
      details: {
        total: 250,
        jobs: [{ id: "one", name: "private reminder", payload: { text: "secret" } }],
      },
    };
    expect(presentation({ action: "list" }, result)).toEqual({
      text: "Automations listed.\nCount: 250",
    });
    expect(presentation({ action: "add" }, result)).toBeUndefined();
  });

  it("presents watcher execution separately from its saved setting", () => {
    const presentation = getToolTerminalPresentation(createCronTool());
    expect(presentation).toBeTypeOf("function");
    const observed = {
      id: "watcher",
      name: "Application errors",
      schedule: { kind: "stream" },
      enabled: false,
      state: { streamStatus: "error", streamError: "PRIVATE_DIAGNOSTIC" },
    };
    const uncertain = presentation?.({ action: "update" }, { content: [], details: observed });
    expect(uncertain?.text).toContain("Paused. Source termination is not confirmed.");
    expect(uncertain?.text).not.toContain("PRIVATE_DIAGNOSTIC");
    expect(
      presentation?.(
        { action: "get" },
        {
          content: [],
          details: {
            ...observed,
            state: { streamStatus: "stopped" },
          },
        },
      )?.text,
    ).toContain("Source termination confirmed.");
    expect(
      presentation?.(
        { action: "add" },
        {
          content: [],
          details: {
            created: true,
            job: { ...observed, enabled: true, state: { streamStatus: "running" } },
          },
        },
      )?.text,
    ).toContain("Source running.");
    expect(
      presentation?.({ action: "remove" }, { content: [], details: { ok: true, removed: true } }),
    ).toBeUndefined();
  });

  it.each([
    {
      name: "script before agent-turn hints",
      input: {
        everyMs: 60_000,
        script: "return { notify: 'changed' }",
        timeoutSeconds: 30,
        toolBudget: 12,
      },
      expected: {
        payload: {
          kind: "script",
          script: "return { notify: 'changed' }",
          timeoutSeconds: 30,
          toolBudget: 12,
        },
      },
    },
    {
      name: "out-of-range timestamp for gateway validation",
      input: { atMs: 8_640_000_000_000_001, message: "report" },
      expected: { schedule: { kind: "at", at: 8_640_000_000_000_001 } },
    },
  ])("recovers $name", async ({ input, expected }) => {
    await execute({ action: "add", name: "reminder", ...input });
    expectAdd(expected);
  });

  it.each([
    {
      name: "explicit on-exit creation",
      args: {
        action: "add",
        kind: "on-exit",
        command: "pnpm build",
        cwd: "/repo",
        message: "rebuilt",
      },
      error: "automation on-exit schedules cannot be created or edited",
    },
    {
      name: "ambiguous command-only update",
      args: { action: "update", jobId: "job", command: "make" },
      error: "Read the full automations schema and WATCH OUTPUT example",
    },
    {
      name: "command creation with a flat interval but no schedule kind",
      args: {
        action: "add",
        name: "Build watcher",
        everyMs: 60_000,
        command: ["tail", "-F", "/tmp/build.log"],
        message: "Report build output",
      },
      error: "Read the full automations schema and WATCH OUTPUT example",
    },
    {
      name: "command creation with a nested cron expression but no schedule kind",
      args: {
        action: "add",
        job: {
          name: "Build watcher",
          schedule: { expr: "* * * * *", command: ["tail", "-F", "/tmp/build.log"] },
          payload: { kind: "agentTurn", message: "Report build output" },
        },
      },
      error: "Read the full automations schema and WATCH OUTPUT example",
    },
    {
      name: "malformed stream creation without a schedule kind",
      args: {
        action: "add",
        job: {
          name: "Build watcher",
          schedule: {
            type: "stream",
            command: "/usr/bin/tail -n 0 -F /tmp/build.log",
            pattern: "^BUILD:",
          },
          payload: { type: "send_message", conversationId: "current", template: "{{line}}" },
        },
      },
      error: "Read the full automations schema and WATCH OUTPUT example",
    },
  ])("rejects $name before Gateway effects", async ({ args, error }) => {
    await expect(execute(args)).rejects.toThrow(error);
    expect(gateway).not.toHaveBeenCalled();
  });

  it("loads the current revision before updating a flat trigger", async () => {
    gateway.mockResolvedValueOnce({
      id: "job",
      configRevision: "sha256:trigger",
      trigger: null,
      payload: { kind: "systemEvent", text: "before" },
    });
    const trigger = { script: "json({ fire: true })", once: false };
    await execute({ action: "update", jobId: "job", trigger });
    expectUpdate("job", { trigger }, "sha256:trigger");
  });

  it("repairs recognized padded keys (#95407)", async () => {
    await execute({
      action: "add",
      job: {
        name: job.name,
        description: "Check-in",
        "schedule ": job.schedule,
        "payload ": job.payload,
        "sessionTarget ": "isolated",
        "enabled ": true,
      },
    });
    expectAdd({ ...job, description: "Check-in", sessionTarget: "isolated", enabled: true });
    for (const key of ["schedule ", "payload ", "sessionTarget ", "enabled "]) {
      expect(gateway.mock.calls[0]?.[2]).not.toHaveProperty(key);
    }
  });

  it("does not repair prototype keys (#95407)", async () => {
    await execute({
      action: "add",
      job: { ...job, "__proto__ ": { malicious: true }, "constructor ": "unrecognized" },
    });
    expectAdd({ "__proto__ ": { malicious: true }, "constructor ": "unrecognized" });
  });

  it("preserves canonical/padded conflicts for gateway rejection (#95407)", async () => {
    const conflict = () => ({
      "schedule ": { kind: "every", everyMs: 60_000 },
      enabled: false,
      "enabled ": true,
    });
    await execute({ action: "add", job: { ...job, ...conflict() } });
    expectAdd({ schedule: job.schedule, ...conflict() });
  });

  it.each([
    { "job.payload.message": "after", "job.payload.kind": "agentTurn" },
    { '"job.payload.message"': "after" },
  ])("recovers sibling or quoted dotted keys: %j (#120616)", async (params) => {
    await update(params);
    expect(updatePatch()).toEqual({ payload: { kind: "agentTurn", message: "after" } });
  });

  it("keeps the explicit structured value authoritative over a conflicting dotted key (#120616)", async () => {
    await update({
      payload: { kind: "agentTurn", message: "before" },
      "job.payload.message": "after",
    });

    expect(updatePatch()).toHaveProperty("payload.message", "before");
    expect(updatePatch()).not.toHaveProperty("job.payload.message");
  });

  it.each([
    ["job.name", "nightly.report"],
    ["job.payload.__proto__.polluted", "yes"],
  ])("does not nest scalar or prototype paths: %s (#120616)", async (key, value) => {
    await expect(update({ [key]: value })).rejects.toThrow("job required");
    expect(gateway).not.toHaveBeenCalled();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("cron schedule updates", () => {
  it("preserves the timezone for flat expressions without leaking scheduleKind", async () => {
    gateway.mockResolvedValueOnce({
      id: "job-kind",
      configRevision: "sha256:test",
      schedule: { kind: "cron", expr: "0 7 * * *", tz: "Asia/Shanghai" },
    });
    await execute({
      action: "update",
      id: "job-kind",
      expr: "0 8 * * *",
      scheduleKind: "cron",
    });
    expectUpdate(
      "job-kind",
      { schedule: { expr: "0 8 * * *", kind: "cron", tz: "Asia/Shanghai" } },
      "sha256:test",
    );
  });

  it.each([
    { schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Paris" } },
    { schedule: { kind: "every", everyMs: 60_000 } },
    { name: "renamed" },
  ])(
    "updates explicit timezones and unrelated fields without reading the job: %j",
    async (patch) => {
      await execute({ action: "update", id: "job-fast-path", job: patch });
      expectUpdate("job-fast-path", patch);
    },
  );

  it.each([
    { kind: "cron", expr: "0 7 * * *" },
    { kind: "every", everyMs: 60_000 },
  ])("does not invent a timezone when the stored schedule has none: %j", async (schedule) => {
    gateway.mockResolvedValueOnce({ id: "job-no-tz", configRevision: "sha256:test", schedule });
    const patch = { schedule: { kind: "cron", expr: "0 8 * * *" } };
    await execute({ action: "update", id: "job-no-tz", job: patch });
    expectUpdate("job-no-tz", patch, "sha256:test");
  });
});
