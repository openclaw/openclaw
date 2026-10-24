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

const schedule = { kind: "stream", command: ["node", "events.mjs"] };
const execTools: NonNullable<CronToolOptions["creatorToolAllowlist"]> = [
  { name: "exec", execOrigin: "openclaw" },
];
const streamJob = {
  name: "watch events",
  schedule,
  payload: { kind: "agentTurn", message: "handle events" },
};

function createStreamTool(params: {
  tools?: CronToolOptions["creatorToolAllowlist"];
  exec?: NonNullable<OpenClawConfig["tools"]>["exec"];
  sandboxed?: boolean;
  stored?: Record<string, unknown>;
}) {
  const config = {
    tools: { exec: { host: "gateway", security: "full", ask: "off", ...params.exec } },
  } satisfies OpenClawConfig;
  setRuntimeConfigSnapshot(config);
  const callGatewayTool = vi.fn(async (method: string) =>
    params.stored !== undefined && method === "cron.get"
      ? {
          ...streamJob,
          id: "stream-1",
          enabled: true,
          configRevision: "revision-1",
          ...params.stored,
        }
      : { ok: true },
  );
  const gatewaySpy = vi.spyOn(gatewayModule, "callGatewayTool").mockImplementation(callGatewayTool);
  onTestFinished(() => gatewaySpy.mockRestore());
  const tool = createCronTool({
    creatorToolAllowlist: params.tools,
    config,
    sandboxed: params.sandboxed,
  });
  return {
    callGatewayTool,
    add: () => tool.execute("stream-add", { action: "add", job: streamJob }),
    update: (job: Record<string, unknown>) =>
      tool.execute("stream-update", { action: "update", jobId: "stream-1", job }),
    methods: () => callGatewayTool.mock.calls.map(([method]) => method),
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

  it("allows creation with Gateway-pinned native exec", async () => {
    const h = createStreamTool({
      tools: [{ name: "exec", execOrigin: "native", execTarget: { host: "gateway" } }],
    });
    await h.add();
    expect(h.callGatewayTool).toHaveBeenCalledWith(
      "cron.add",
      expect.anything(),
      expect.objectContaining({ schedule }),
    );
  });

  it("does not forward an ask-always stream without captured creator authority", async () => {
    const h = createStreamTool({ tools: execTools, exec: { ask: "always" } });
    await expect(h.add()).rejects.toThrow("requires the user's approval");
    expect(h.callGatewayTool).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "sandbox execution context is missing",
      tools: execTools,
      exec: { host: "auto", ask: "always" },
      sandboxed: true,
    },
    { label: "exec is allowlisted", tools: execTools, exec: { mode: "allowlist" } },
    {
      label: "a Gateway pin cannot override sandbox placement",
      tools: [{ name: "exec", execOrigin: "openclaw", execTarget: { host: "gateway" } }],
      exec: { host: "auto" },
      sandboxed: true,
    },
    { label: "legacy exec has no captured origin", tools: ["exec"] },
  ] satisfies (Parameters<typeof createStreamTool>[0] & { label: string })[])(
    "rejects creation when $label",
    async (params) => {
      const h = createStreamTool(params);
      await expect(h.add()).rejects.toThrow("Gateway exec authority");
      expect(h.callGatewayTool).not.toHaveBeenCalled();
    },
  );

  it("requires authority for a command edit", async () => {
    const h = createStreamTool({ tools: ["read"], stored: {} });
    const patch = { schedule: { ...schedule, command: ["node", "replacement.mjs"] } };
    await expect(h.update(patch)).rejects.toThrow("Gateway exec authority");
    expect(h.methods()).toEqual(["cron.get"]);
  });

  it.each([
    { label: "disablement", patch: { enabled: false }, methods: ["cron.update"] },
    { label: "unchanged source", patch: { schedule }, methods: ["cron.get", "cron.update"] },
    {
      label: "non-stream replacement and enable",
      stored: { enabled: false },
      patch: { enabled: true, schedule: { kind: "every", everyMs: 60_000 } },
      methods: ["cron.get", "cron.update"],
    },
  ] satisfies {
    label: string;
    stored?: Record<string, unknown>;
    patch: Record<string, unknown>;
    methods: string[];
  }[])("allows $label without exec authority", async ({ patch, methods, ...params }) => {
    const h = createStreamTool({ tools: ["read"], stored: {}, ...params });
    await h.update(patch);
    expect(h.methods()).toEqual(methods);
    expect(h.callGatewayTool).toHaveBeenLastCalledWith(
      "cron.update",
      expect.anything(),
      expect.objectContaining({ id: "stream-1", patch }),
    );
  });
});
