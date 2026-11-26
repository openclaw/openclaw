import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestConfigSnapshot } from "../../commands/test-runtime-config-helpers.js";
import * as nodeService from "../../daemon/node-service.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { createTempHomeEnv, type TempHomeEnv } from "../../test-utils/temp-home.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { finishParams } from "./update-command-maintenance-fixtures.test-support.js";
import { completePostUpdateMaintenance } from "./update-command-post-update-maintenance.js";

// Shell setup and persisted retries are separate from result guidance.
vi.mock("./update-command-service.js", async (original) => ({
  ...(await original<typeof import("./update-command-service.js")>()),
  tryInstallShellCompletion: async () => undefined,
}));
vi.mock("./update-command-owed.js", async (original) => ({
  ...(await original<typeof import("./update-command-owed.js")>()),
  retryOwedUpdateSteps: async () => [],
}));
let home: TempHomeEnv;
beforeEach(async () => {
  home = await createTempHomeEnv("node-package-advice-");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await home.restore();
});

async function fixture(json = true, state = "running") {
  const root = path.join(home.home, "updated package");
  const serviceRoot = state === "foreign" ? path.join(home.home, "different package") : root;
  const entrypoint = path.join(serviceRoot, "dist", "index.js");
  await fs.mkdir(path.dirname(entrypoint), { recursive: true });
  await fs.writeFile(entrypoint, "");
  await fs.writeFile(path.join(serviceRoot, "package.json"), '{"name":"openclaw"}');
  if (state === "foreign") {
    await fs.mkdir(root);
    await fs.writeFile(path.join(root, "package.json"), '{"name":"openclaw"}');
  }
  const restart = vi.fn();
  const service = createMockGatewayService({
    readCommand: async () =>
      state === "missing"
        ? null
        : {
            programArguments: [process.execPath, entrypoint, "node", "run"],
            environment: { OPENCLAW_SERVICE_KIND: "node" },
          },
    readRuntime: async () =>
      state === "stopped" ? { status: "stopped" } : { status: "running", pid: 5151 },
    restart,
  });
  vi.spyOn(nodeService, "resolveNodeService").mockReturnValue(service);
  const result: UpdateRunResult = {
    status: "ok",
    mode: "npm",
    root,
    before: { version: "1.0.0" },
    after: { version: "1.0.1" },
    steps: [],
    durationMs: 1,
  };
  const params = finishParams({
    root,
    result,
    configSnapshot: createTestConfigSnapshot({}),
    opts: { json, run: { runId: "node-only-update", env: { OPENCLAW_PROFILE: "work" } } },
    preManagedServiceStop: {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceUpdateVerdict: { kind: "absent" },
    },
  });
  return { params, restart };
}

it.each([false, true])(
  "reports the running same-package node without restarting it, json=%s",
  async (json) => {
    const { params, restart } = await fixture(json);
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await completePostUpdateMaintenance(params, params.result, () => {}, { root: params.root });
    const advice = params.result.steps[0]?.stdoutTail;
    expect(advice).toContain("Node service is still running (PID 5151)");
    expect(advice).toContain(path.join(params.root, "openclaw.mjs"));
    expect(advice).toContain("--profile work node restart");
    expect(advice).toContain("idle");
    expect(advice).not.toContain("node install --force");
    expect(params.result.steps[0]?.diagnostics).toEqual([advice]);
    if (json) {
      expect(log).not.toHaveBeenCalled();
    } else {
      expect(log).toHaveBeenCalledExactlyOnceWith(advice);
    }
    expect(restart).not.toHaveBeenCalled();
  },
);

it.each(["foreign", "stopped", "missing", "failure", "git", "uninspected", "current"] as const)(
  "does not advise restarting the node after %s",
  async (kind) => {
    const { params, restart } = await fixture(true, kind);
    if (kind === "failure") {
      params.result.status = "error";
    }
    if (kind === "git") {
      params.result.mode = "git";
    }
    if (kind === "uninspected") {
      delete params.preManagedServiceStop;
    }
    if (kind === "current") {
      params.coreAlreadyCurrent = true;
    }
    await completePostUpdateMaintenance(params, params.result, () => {}, { root: params.root });
    expect(params.result.steps.some((step) => step.name === "advisory:node-restart")).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  },
);

it("prints an executable PowerShell command for an installation path containing spaces", async () => {
  const { params } = await fixture();
  mockProcessPlatform("win32");
  await completePostUpdateMaintenance(params, params.result, () => {}, { root: params.root });
  expect(params.result.steps[0]?.stdoutTail).toContain("`& '");
  expect(params.result.steps[0]?.stdoutTail).toContain("--profile work node restart`");
});
