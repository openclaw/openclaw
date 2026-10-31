import { afterAll, afterEach, beforeAll, expect, it, onTestFinished, vi } from "vitest";
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
const gatewayExec = {
  name: "exec",
  execOrigin: "native",
  execTarget: { host: "gateway" },
} as const;
const streamJob = { name: "events", schedule, payload: { kind: "agentTurn", message: "event" } };

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
    creatorToolAllowlist: params.tools ?? execTools,
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

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "cron-stream-exec-policy" });
  saveExecApprovals({ version: 1, defaults: { security: "full", ask: "off" } });
});
afterAll(async () => await state.cleanup());
afterEach(clearRuntimeConfigSnapshot);

it("allows creation with Gateway-pinned native exec", async () => {
  const h = createStreamTool({ tools: [gatewayExec] });
  await h.add();
  expect(h.methods()).toEqual(["cron.add"]);
});

it("does not forward an ask-always stream without captured creator authority", async () => {
  const h = createStreamTool({ exec: { ask: "always" } });
  await expect(h.add()).rejects.toThrow("requires the user's approval");
  expect(h.callGatewayTool).not.toHaveBeenCalled();
});

it.each([
  ["missing sandbox", { exec: { host: "auto", ask: "always" }, sandboxed: true }],
  ["allowlisted exec", { exec: { mode: "allowlist" } }],
  [
    "sandbox overrides Gateway pin",
    {
      tools: [{ ...gatewayExec, execOrigin: "openclaw" }],
      exec: { host: "auto" },
      sandboxed: true,
    },
  ],
  ["uncaptured legacy origin", { tools: ["exec"] }],
] satisfies [string, Parameters<typeof createStreamTool>[0]][])(
  "rejects creation: %s",
  async (_, params) => {
    const h = createStreamTool(params);
    await expect(h.add()).rejects.toThrow("Gateway exec authority");
    expect(h.callGatewayTool).not.toHaveBeenCalled();
  },
);

it.each([
  { label: "disablement", patch: { enabled: false }, methods: ["cron.update"] },
  { label: "unchanged source", patch: { schedule }, methods: ["cron.get", "cron.update"] },
  {
    label: "non-stream replacement and enable",
    stored: { enabled: false },
    patch: { enabled: true, schedule: { kind: "every", everyMs: 60_000 } },
    methods: ["cron.get", "cron.update"],
  },
] as const)("allows $label without exec authority", async ({ patch, methods, ...params }) => {
  const h = createStreamTool({ tools: ["read"], stored: {}, ...params });
  await h.update(patch);
  expect(h.methods()).toEqual(methods);
});
