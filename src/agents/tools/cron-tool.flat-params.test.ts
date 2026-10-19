import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/config.js";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronTool } from "./cron-tool.js";
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

  it("prefers a script payload to agent-turn hints", async () => {
    const script = { script: "return { notify: 'changed' }", timeoutSeconds: 30, toolBudget: 12 };
    await execute({ action: "add", name: "reminder", everyMs: 60_000, ...script });
    expectAdd({ payload: { kind: "script", ...script } });
  });
  it("forwards out-of-range timestamps for gateway validation", async () => {
    const atMs = 8_640_000_000_000_001;
    await execute({ action: "add", name: "reminder", atMs, message: "report" });
    expectAdd({ schedule: { kind: "at", at: atMs } });
  });
  it("rejects on-exit shorthand", async () => {
    const args = {
      action: "add",
      kind: "on-exit",
      command: "pnpm build",
      cwd: "/repo",
      message: "rebuilt",
    };
    await expect(execute(args)).rejects.toThrow(
      "automation on-exit schedules cannot be created or edited",
    );
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
