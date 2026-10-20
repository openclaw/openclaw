import { afterAll, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { saveExecApprovals } from "../../infra/exec-approvals-store.test-support.js";
import { createOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { createCronTool } from "./cron-tool.js";
import type { CronToolOptions } from "./cron-tool.types.js";
import * as gatewayModule from "./gateway.js";

function streamJob() {
  return {
    name: "watch events",
    schedule: { kind: "stream", command: ["node", "events.mjs"] },
    payload: { kind: "agentTurn", message: "handle events" },
  };
}

function createStreamTool(params: {
  tools?: CronToolOptions["creatorToolAllowlist"];
  exec?: NonNullable<OpenClawConfig["tools"]>["exec"];
  sandboxed?: boolean;
}) {
  const config = {
    tools: { exec: { host: "gateway", security: "full", ask: "off", ...params.exec } },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(config);
  const callGatewayTool = vi.fn();
  callGatewayTool.mockResolvedValue({ ok: true });
  const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(callGatewayTool);
  onTestFinished(() => gatewaySpy.mockRestore());
  return {
    callGatewayTool,
    tool: createCronTool({
      creatorToolAllowlist: params.tools,
      config,
      sandboxed: params.sandboxed,
    }),
  };
}

describe("cron stream creator exec policy", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  beforeAll(async () => {
    state = await createOpenClawTestState({ label: "cron-stream-exec-policy" });
    saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
  });
  afterAll(async () => await state.cleanup());

  beforeEach(() => {
    setRuntimeConfigSnapshot({});
    onTestFinished(clearRuntimeConfigSnapshot);
  });

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

  it("does not forward an ask-always stream as an operator without captured creator authority", async () => {
    const { tool, callGatewayTool } = createStreamTool({
      tools: [{ name: "exec", execOrigin: "openclaw" }],
      exec: { ask: "always" },
    });

    await expect(
      tool.execute("stream-without-creator-grant", { action: "add", job: streamJob() }),
    ).rejects.toThrow("requires the user's approval");
    expect(callGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    { label: "exec is absent", tools: ["read"] },
    {
      label: "sandbox execution context is missing",
      tools: [{ name: "exec", execOrigin: "openclaw" }],
      exec: { host: "auto", ask: "always" },
      sandboxed: true,
    },
    {
      label: "exec is allowlisted",
      tools: [{ name: "exec", execOrigin: "openclaw" }],
      exec: { mode: "allowlist" },
    },
    {
      label: "a captured Gateway pin cannot override sandbox placement",
      tools: [{ name: "exec", execOrigin: "openclaw", execTarget: { host: "gateway" } }],
      exec: { host: "auto" },
      sandboxed: true,
    },
    {
      label: "exec is an unpinned native shell even when OpenClaw defaults resolve Gateway",
      tools: [{ name: "exec", execOrigin: "native" }],
    },
    { label: "legacy exec has no captured runtime origin", tools: ["exec"] },
  ] satisfies (Parameters<typeof createStreamTool>[0] & { label: string })[])(
    "rejects creation when $label",
    async (params) => {
      const { tool, callGatewayTool } = createStreamTool(params);

      await expect(
        tool.execute("stream-add-denied", { action: "add", job: streamJob() }),
      ).rejects.toThrow("Gateway exec authority");
      expect(callGatewayTool).not.toHaveBeenCalled();
    },
  );

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
    ).rejects.toThrow("Gateway exec authority");
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
    ).rejects.toThrow("Gateway exec authority");

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
    ).rejects.toThrow("Gateway exec authority");
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
    ).rejects.toThrow("Gateway exec authority");
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
    ).rejects.toThrow("Gateway exec authority");
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
    ).rejects.toThrow("Gateway exec authority");
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
    ).rejects.toThrow("Gateway exec authority");
    expect(callGatewayTool.mock.calls.map((call) => call[0])).toEqual([
      "cron.get",
      "cron.update",
      "cron.get",
    ]);
  });
});
