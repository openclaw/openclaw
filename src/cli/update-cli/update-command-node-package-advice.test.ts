import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type * as NodeServiceModule from "../../daemon/node-service.js";
import type { UpdateRunResult } from "../../infra/update-runner-types.js";
import { defaultRuntime } from "../../runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { completePostUpdateMaintenance } from "./update-command-post-update-maintenance.js";

vi.mock("./update-command-service.js", () => ({
  tryInstallShellCompletion: vi.fn(async () => undefined),
}));
vi.mock("./update-command-owed.js", () => ({
  retryOwedUpdateSteps: vi.fn(async () => []),
}));

// Final result guidance consumes captured ownership; it must not reopen native inspection.
vi.mock("../../daemon/node-service.js", async (original) => ({
  ...(await original<typeof NodeServiceModule>()),
  resolveNodeService: () => {
    throw new Error("Result guidance must not inspect services");
  },
}));
afterEach(() => vi.restoreAllMocks());

function fixture(json = true) {
  const root = path.resolve("/updated/package");
  const result: UpdateRunResult = {
    status: "ok",
    mode: "npm",
    root,
    before: { version: "1.0.0" },
    after: { version: "1.0.1" },
    steps: [],
    durationMs: 1,
  };
  const params: Parameters<typeof completePostUpdateMaintenance>[0] & {
    result: UpdateRunResult;
  } = {
    root,
    result,
    installKindChanged: false,
    opts: { json, run: { runId: "node-only-update", env: { OPENCLAW_PROFILE: "work" } } },
    preManagedServiceStop: {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceUpdateVerdict: { kind: "absent" },
    },
  };
  return params;
}

it.each([false, true])(
  "names node installation and restart in the package result, json=%s",
  async (json) => {
    const params = fixture(json);
    const log = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    await completePostUpdateMaintenance(params, params.result, () => {}, { root: params.root });
    const advice = params.result.steps[0]?.stdoutTail;
    expect(advice).toContain("does not restart a retained node runtime");
    expect(advice).toContain(path.join(params.root, "openclaw.mjs"));
    expect(advice).toContain("node install --force");
    expect(advice).toContain("node restart");
    expect(advice).toContain("--profile work");
    expect(advice).toContain("work to be idle");
    expect(log).toHaveBeenCalledTimes(json ? 0 : 1);
  },
);

it.each(["failure", "git", "uninspected"] as const)(
  "does not invent node activation after %s",
  async (kind) => {
    const params = fixture();
    if (kind === "failure") {
      params.result.status = "error";
    }
    if (kind === "git") {
      params.result.mode = "git";
    }
    if (kind === "uninspected") {
      delete params.preManagedServiceStop;
    }
    await completePostUpdateMaintenance(params, params.result, () => {}, { root: params.root });
    expect(
      params.result.steps.find((step) => step.name === "advisory:node-restart"),
    ).toBeUndefined();
  },
);

it("prints separate executable PowerShell commands for Windows paths", async () => {
  mockProcessPlatform("win32");
  const params = fixture();
  params.result.root = "C:\\Updated Package";
  await completePostUpdateMaintenance(params, params.result, () => {}, { root: params.root });
  expect(params.result.steps[0]?.stdoutTail).toContain("`& '");
  expect(params.result.steps[0]?.stdoutTail).toContain("node install --force`, then `& '");
  expect(params.result.steps[0]?.stdoutTail).not.toContain("&&");
});
