import { describe, expect, it, vi } from "vitest";
import type { ResolvedExecDefaults } from "../exec-defaults.js";
import { createCronTool } from "./cron-tool.js";

const FULL_GATEWAY_EXEC: ResolvedExecDefaults = {
  host: "gateway",
  effectiveHost: "gateway",
  mode: "full",
  security: "full",
  ask: "off",
  canRequestNode: true,
};

function withExecDefaults(overrides: Partial<ResolvedExecDefaults>): ResolvedExecDefaults {
  return { ...FULL_GATEWAY_EXEC, ...overrides };
}

function streamJob() {
  return {
    name: "watch events",
    schedule: { kind: "stream", command: ["node", "events.mjs"] },
    payload: { kind: "agentTurn", message: "handle events" },
  };
}

function createStreamTool(params: {
  tools?: Array<
    | string
    | {
        name: string;
        execOrigin?: "openclaw" | "native";
        execTarget?: { host: "gateway"; ask?: "always" };
      }
  >;
  execDefaults?: ResolvedExecDefaults;
}) {
  const callGatewayTool = vi.fn();
  callGatewayTool.mockResolvedValue({ ok: true });
  return {
    callGatewayTool,
    tool: createCronTool(
      { creatorToolAllowlist: params.tools },
      {
        callGatewayTool,
        resolveExecDefaults: () => params.execDefaults ?? FULL_GATEWAY_EXEC,
      },
    ),
  };
}

describe("cron stream creator exec policy", () => {
  it("allows creation when the final creator surface has unattended full Gateway exec", async () => {
    const { tool, callGatewayTool } = createStreamTool({
      tools: [{ name: "exec", execOrigin: "openclaw" }],
    });

    await tool.execute("stream-add", { action: "add", job: streamJob() });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ schedule: streamJob().schedule }),
    );
  });

  it("allows native exec only when its runtime owner pins it to Gateway", async () => {
    const { tool, callGatewayTool } = createStreamTool({
      tools: [
        {
          name: "exec",
          execOrigin: "native",
          execTarget: { host: "gateway" },
        },
      ],
    });

    await tool.execute("native-gateway-stream-add", { action: "add", job: streamJob() });

    expect(callGatewayTool).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ schedule: streamJob().schedule }),
    );
  });

  it.each([
    ["exec is absent", ["read"], FULL_GATEWAY_EXEC],
    [
      "exec is sandboxed",
      [{ name: "exec", execOrigin: "openclaw" as const }],
      withExecDefaults({ host: "auto", effectiveHost: "sandbox" }),
    ],
    [
      "exec is allowlisted",
      [{ name: "exec", execOrigin: "openclaw" as const }],
      withExecDefaults({ mode: "allowlist", security: "allowlist" }),
    ],
    [
      "exec requires approval",
      [{ name: "exec", execOrigin: "openclaw" as const }],
      withExecDefaults({ mode: "ask", ask: "always" }),
    ],
    [
      "the captured exec alias requires approval",
      [
        {
          name: "exec",
          execOrigin: "openclaw" as const,
          execTarget: { host: "gateway" as const, ask: "always" as const },
        },
      ],
      FULL_GATEWAY_EXEC,
    ],
    [
      "a captured Gateway pin cannot override sandbox placement",
      [
        {
          name: "exec",
          execOrigin: "openclaw" as const,
          execTarget: { host: "gateway" as const },
        },
      ],
      withExecDefaults({ host: "auto", effectiveHost: "sandbox" }),
    ],
    [
      "exec is an unpinned native shell even when OpenClaw defaults resolve Gateway",
      [{ name: "exec", execOrigin: "native" as const }],
      FULL_GATEWAY_EXEC,
    ],
    ["legacy exec has no captured runtime origin", ["exec"], FULL_GATEWAY_EXEC],
  ])("rejects creation when %s", async (_label, tools, execDefaults) => {
    const { tool, callGatewayTool } = createStreamTool({ tools, execDefaults });

    await expect(
      tool.execute("stream-add-denied", { action: "add", job: streamJob() }),
    ).rejects.toThrow("unattended full Gateway exec authority");
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it("rechecks stream command edits while leaving disablement alone", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? { ...streamJob(), id: "stream-1", enabled: true, configRevision: "revision-1" }
        : { ok: true },
    );

    await expect(
      tool.execute("stream-command-edit", {
        action: "update",
        jobId: "stream-1",
        job: { schedule: { kind: "stream", command: ["node", "replacement.mjs"] } },
      }),
    ).rejects.toThrow("unattended full Gateway exec authority");
    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get"]);

    callGatewayTool.mockClear();
    await tool.execute("stream-disable", {
      action: "update",
      jobId: "stream-1",
      job: { enabled: false },
    });
    expect(callGatewayTool).toHaveBeenCalledWith(
      "cron.update",
      expect.anything(),
      expect.objectContaining({ id: "stream-1", patch: { enabled: false } }),
    );
  });

  it("allows an unchanged stream schedule resave without exec authority", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? { ...streamJob(), id: "stream-1", enabled: true, configRevision: "revision-1" }
        : { ok: true },
    );

    await tool.execute("stream-resave", {
      action: "update",
      jobId: "stream-1",
      job: { schedule: streamJob().schedule },
    });

    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get", "cron.update"]);
  });

  it("rejects a same-command stream replacement that omits stored cwd", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? {
            ...streamJob(),
            id: "stream-1",
            enabled: true,
            schedule: { ...streamJob().schedule, cwd: "/workspace" },
            configRevision: "revision-1",
          }
        : { ok: true },
    );

    await expect(
      tool.execute("stream-omit-cwd-denied", {
        action: "update",
        jobId: "stream-1",
        job: { schedule: streamJob().schedule },
      }),
    ).rejects.toThrow("unattended full Gateway exec authority");

    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get"]);
  });

  it("allows enabling a disabled stream while replacing it with a non-stream schedule", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? { ...streamJob(), id: "stream-1", enabled: false, configRevision: "revision-1" }
        : { ok: true },
    );

    await tool.execute("stream-replace-and-enable", {
      action: "update",
      jobId: "stream-1",
      job: { enabled: true, schedule: { kind: "every", everyMs: 60_000 } },
    });

    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get", "cron.update"]);
    expect(callGatewayTool).toHaveBeenLastCalledWith(
      "cron.update",
      expect.anything(),
      expect.objectContaining({
        id: "stream-1",
        patch: { enabled: true, schedule: { kind: "every", everyMs: 60_000 } },
      }),
    );
  });

  it("requires full Gateway exec authority to re-enable a stored stream", async () => {
    const weak = createStreamTool({ tools: ["read"] });
    weak.callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? { ...streamJob(), id: "stream-1", enabled: false, configRevision: "revision-1" }
        : { ok: true },
    );

    await expect(
      weak.tool.execute("stream-enable-denied", {
        action: "update",
        jobId: "stream-1",
        job: { enabled: true },
      }),
    ).rejects.toThrow("unattended full Gateway exec authority");
    expect(weak.callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get"]);

    const strong = createStreamTool({
      tools: [{ name: "exec", execOrigin: "openclaw" }],
    });
    strong.callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? { ...streamJob(), id: "stream-1", enabled: false, configRevision: "revision-1" }
        : { ok: true },
    );
    await strong.tool.execute("stream-enable-allowed", {
      action: "update",
      jobId: "stream-1",
      job: { enabled: true },
    });
    expect(strong.callGatewayTool.mock.calls.map((call) => call[0])).toEqual([
      "cron.get",
      "cron.update",
    ]);
  });

  it("requires authority for state-only stream restart recovery", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? {
            ...streamJob(),
            id: "stream-1",
            enabled: true,
            state: { streamRestartExhausted: true },
            configRevision: "revision-1",
          }
        : { ok: true },
    );

    await expect(
      tool.execute("stream-state-recover-denied", {
        action: "update",
        jobId: "stream-1",
        job: { state: { streamRestartExhausted: false } },
      }),
    ).rejects.toThrow("unattended full Gateway exec authority");
    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get"]);
  });

  it("requires authority for enabled true on an already enabled stream", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? { ...streamJob(), id: "stream-1", enabled: true, configRevision: "revision-1" }
        : { ok: true },
    );

    await expect(
      tool.execute("stream-enabled-race-denied", {
        action: "update",
        jobId: "stream-1",
        job: { enabled: true },
      }),
    ).rejects.toThrow("unattended full Gateway exec authority");
    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get"]);
  });

  it("requires authority to recover an enabled restart-exhausted stream", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    callGatewayTool.mockImplementation(async (method: string) =>
      method === "cron.get"
        ? {
            ...streamJob(),
            id: "stream-1",
            enabled: true,
            state: { streamRestartExhausted: true },
            configRevision: "revision-1",
          }
        : { ok: true },
    );

    await expect(
      tool.execute("stream-recover-denied", {
        action: "update",
        jobId: "stream-1",
        job: { enabled: true },
      }),
    ).rejects.toThrow("unattended full Gateway exec authority");
    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual(["cron.get"]);
  });

  it("rechecks source authority after a stale config revision", async () => {
    const { tool, callGatewayTool } = createStreamTool({ tools: ["read"] });
    let reads = 0;
    callGatewayTool.mockImplementation(async (method: string) => {
      if (method === "cron.get") {
        reads += 1;
        return {
          ...streamJob(),
          id: "stream-1",
          enabled: true,
          schedule:
            reads === 1
              ? streamJob().schedule
              : { ...streamJob().schedule, mode: "match", match: "event" },
          configRevision: `revision-${reads}`,
        };
      }
      if (method === "cron.update") {
        const conflict = new Error("cron job changed") as Error & {
          details: { code: string };
        };
        conflict.name = "GatewayClientRequestError";
        conflict.details = { code: "CRON_JOB_CHANGED" };
        throw conflict;
      }
      return { ok: true };
    });

    await expect(
      tool.execute("stream-source-stale", {
        action: "update",
        jobId: "stream-1",
        job: { schedule: streamJob().schedule },
      }),
    ).rejects.toThrow("unattended full Gateway exec authority");
    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual([
      "cron.get",
      "cron.update",
      "cron.get",
    ]);
  });
});
