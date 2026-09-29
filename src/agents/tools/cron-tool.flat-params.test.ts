import { beforeEach, describe, expect, it, vi } from "vitest";
import { getToolTerminalPresentation } from "../tool-terminal-presentation.js";
import { createCronTool } from "./cron-tool.js";

const gateway = vi.fn();
const job = {
  name: "reminder",
  schedule: { kind: "cron", expr: "0 12 * * *", tz: "UTC" },
  payload: { kind: "agentTurn", message: "work" },
};
function execute(args: Record<string, unknown>) {
  return createCronTool(undefined, { callGatewayTool: gateway }).execute("cron", args);
}
function expectAdd(params: Record<string, unknown>) {
  expect(gateway).toHaveBeenCalledExactlyOnceWith(
    "cron.add",
    expect.anything(),
    expect.objectContaining(params),
  );
}

beforeEach(() => {
  gateway.mockReset().mockResolvedValue({ ok: true });
});

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

  it.each([
    {
      name: "cron with timezone and stagger",
      input: { cron: "0 18 * * *", tz: "Asia/Shanghai", staggerMs: 5000, message: "report" },
      expected: {
        schedule: { kind: "cron", expr: "0 18 * * *", tz: "Asia/Shanghai", staggerMs: 5000 },
        payload: { kind: "agentTurn", message: "report" },
      },
    },
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
    { action: "add", kind: "on-exit", command: "pnpm build", cwd: "/repo", message: "rebuilt" },
    { action: "update", jobId: "job", command: "make" },
  ])("rejects explicit or inferred on-exit shorthand on $action", async (args) => {
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
    expect(gateway.mock.calls).toEqual([
      ["cron.get", expect.anything(), { id: "job" }],
      [
        "cron.update",
        expect.anything(),
        { id: "job", expectedConfigRevision: "sha256:trigger", patch: { trigger } },
      ],
    ]);
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
    await execute({
      action: "add",
      job: {
        ...job,
        "schedule ": { kind: "every", everyMs: 60_000 },
        enabled: false,
        "enabled ": true,
      },
    });
    expectAdd({
      schedule: job.schedule,
      enabled: false,
      "schedule ": { kind: "every", everyMs: 60_000 },
      "enabled ": true,
    });
  });
});
