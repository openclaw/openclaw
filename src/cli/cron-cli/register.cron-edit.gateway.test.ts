// Cron edit script-only replacement runs through the real Gateway cron handlers
// against a real persisted store, proving trigger.once survives the edit (#119916).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronService } from "../../cron/service.js";
import {
  createCronStoreHarness,
  createNoopLogger,
  writeCronStoreSnapshot,
} from "../../cron/service.test-harness.js";
import { loadCronJobsStoreSync } from "../../cron/store.js";
import type { CronJob } from "../../cron/types.js";
import type { GatewayCronServiceContract } from "../../gateway/server-cron-contract.js";
import { cronHandlers } from "../../gateway/server-methods/cron.js";

const mocks = vi.hoisted(() => {
  const runtime = {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn((code: number) => {
      throw new Error(`exit ${code}`);
    }),
  };
  return { runtime, callGatewayFromCli: vi.fn() };
});

vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks.runtime }));

vi.mock("../gateway-rpc.js", async () => {
  const actual = await vi.importActual<typeof import("../gateway-rpc.js")>("../gateway-rpc.js");
  return {
    ...actual,
    callGatewayFromCli: (...args: Parameters<typeof actual.callGatewayFromCli>) =>
      mocks.callGatewayFromCli(...args),
  };
});

const { registerCronEditCommand } = await import("./register.cron-edit.js");
const harness = createCronStoreHarness({ prefix: "cron-edit-gateway-" });

function createJob(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "job-1",
    enabled: true,
    createdAtMs: 1,
    updatedAtMs: 1,
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: "scheduled check" },
    state: { nextRunAtMs: 2 },
    ...overrides,
  };
}

function installRealCronGateway(storePath: string): CronService {
  const logger = createNoopLogger();
  const cron = new CronService({
    storePath,
    cronEnabled: true,
    cronConfig: { triggers: { enabled: true } },
    log: logger,
    defaultAgentId: "main",
  });
  void cron.start();
  const service = cron as unknown as GatewayCronServiceContract;
  mocks.callGatewayFromCli.mockImplementation(
    async (method: string, _opts: unknown, params: Record<string, unknown> = {}) => {
      const handler = expectDefined(cronHandlers[method], `missing Gateway method ${method}`);
      let response:
        | { ok?: boolean; payload?: unknown; error?: { code?: string; message?: string } }
        | undefined;
      await handler({
        req: {} as never,
        params,
        respond: (ok: boolean, payload?: unknown, error?: { code?: string; message?: string }) => {
          response = { ok, payload, error };
        },
        context: {
          cron: service,
          logGateway: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
          getRuntimeConfig: () => ({ cron: { triggers: { enabled: true } } }),
        } as never,
      } as never);
      const result = expectDefined(response, `${method} returned no Gateway response`);
      if (!result.ok) {
        throw Object.assign(new Error(result.error?.message ?? `${method} failed`), {
          name: "GatewayClientRequestError",
          gatewayCode: result.error?.code ?? "INVALID_REQUEST",
        });
      }
      return result.payload;
    },
  );
  return cron;
}

async function runEdit(args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerCronEditCommand(program);
  await program.parseAsync(args, { from: "user" });
}

beforeEach(() => {
  mocks.runtime.error.mockClear();
  mocks.runtime.writeJson.mockClear();
  mocks.runtime.exit.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("cron edit script-only replacement through the real Gateway cron store", () => {
  it("preserves trigger.once when only the script body is replaced (#119916)", async () => {
    const { storePath, cleanup } = await harness.makeStorePath();
    await writeCronStoreSnapshot({
      storePath,
      jobs: [
        createJob({
          trigger: { script: "return { fire: false };", once: true },
        }),
      ],
    });
    const scriptPath = path.join(os.tmpdir(), `cron-edit-gateway-script-${Date.now()}.js`);
    await fs.writeFile(scriptPath, "return { fire: true };", "utf8");
    const cron = installRealCronGateway(storePath);
    try {
      await runEdit(["edit", "job-1", "--trigger-script", scriptPath]);
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
      const stored = loadCronJobsStoreSync(storePath).jobs;
      const job = stored.find((candidate) => candidate.id === "job-1");
      expect(job?.trigger).toMatchObject({ once: true, script: "return { fire: true };" });
    } finally {
      cron.stop();
      await cleanup();
      await fs.rm(scriptPath, { force: true });
    }
  });
});
