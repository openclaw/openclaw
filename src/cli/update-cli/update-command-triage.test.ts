import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as configureShared from "../../commands/configure.shared.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
import { CONTROL_PLANE_UPDATE_SENTINEL_META_ENV } from "../../infra/update-control-plane-sentinel.js";
import * as updateFailureReport from "../../infra/update-failure-report.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { defaultRuntime, ExitError } from "../../runtime.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { expectMessages, expectMissing, expectNoCalls } from "./update-boundary.test-support.js";
import { resultFixture, stepFixture } from "./update-command-fixtures.test-support.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { withUpdateFailureTriage, type UpdateTriageTarget } from "./update-command-triage.js";

const reportActionSelect = vi.hoisted(() => vi.fn<() => Promise<string | symbol>>());
vi.mock("../../commands/configure.shared.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/configure.shared.js")>()),
  select: reportActionSelect,
}));
vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: async () => true,
}));

const triageAfterFailure = vi.hoisted(() => vi.fn());
vi.mock("../../commands/triage-failure.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../commands/triage-failure.js")>()),
  triageAfterFailure,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

const failedUpdate = resultFixture(undefined, {
  status: "error",
  reason: "global-install-failed",
  before: { version: "2026.8.1" },
  steps: [stepFixture("global install", { stderrTail: "ENOSPC" })],
});

async function createInstalledTriage(rejectRepair = false) {
  const root = await fs.realpath(tempDirs.make("openclaw-update-triage-"));
  await fs.mkdir(path.join(root, "dist"));
  // The real child consumes the failure export and environment after the caller unwinds.
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `
    const fs = require("node:fs");
    const path = require("node:path");
    ${rejectRepair ? 'if (process.connected) throw new Error("Unattended update admitted a repair agent");' : ""}
    const args = process.argv.slice(2);
    const input = args[args.indexOf("--update-result") + 1];
    fs.writeFileSync(path.join(${JSON.stringify(root)}, "receipt.json"), JSON.stringify({
      args,
      failure: JSON.parse(fs.readFileSync(input, "utf8")),
      stateDir: process.env.OPENCLAW_STATE_DIR,
      configPath: process.env.OPENCLAW_CONFIG_PATH,
      updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS,
      serviceMarker: process.env.OPENCLAW_SERVICE_MARKER,
      released: fs.existsSync(path.join(${JSON.stringify(root)}, "released")),
    }));
    process.stdout.write(args.includes("--json")
      ? JSON.stringify({promptPath: path.join(process.cwd(), "prompt.md"), bundlePath: null, bundleError: null}) + "\\n"
      : "triage report\\n");
  `,
  );
  return {
    root,
    nodeRunner: process.execPath,
    env: {
      HOME: root,
      USERPROFILE: root,
      OPENCLAW_STATE_DIR: path.join(root, "named-state"),
      OPENCLAW_CONFIG_PATH: path.join(root, "custom-config.json"),
      OPENCLAW_UPDATE_IN_PROGRESS: "1",
      OPENCLAW_SERVICE_MARKER: "openclaw",
    },
  } satisfies UpdateTriageTarget;
}

function failUpdate(
  target: UpdateTriageTarget,
  options: Parameters<typeof withUpdateFailureTriage>[0] = {},
  failure: unknown = new UpdateCommandFailure(failedUpdate),
) {
  return withUpdateFailureTriage(options, target, async () => {
    throw failure;
  });
}

async function readReceipt(target: { root: string }) {
  return JSON.parse(await fs.readFile(path.join(target.root, "receipt.json"), "utf8")) as {
    args: string[];
    failure: unknown;
    stateDir: string;
    configPath: string;
    updateInProgress?: string;
    serviceMarker?: string;
    released: boolean;
  };
}

async function expectNoTriage(target: { root: string }) {
  await expectMissing(path.join(target.root, "receipt.json"));
  expectNoCalls(defaultRuntime.exit);
}

async function createManagedTriageTarget() {
  const target = await createInstalledTriage();
  const handoffDir = path.join(target.root, "handoff");
  await fs.mkdir(handoffDir, { mode: 0o700 });
  const contextPath = path.join(handoffDir, "update-failure.json");
  const metaPath = path.join(handoffDir, "sentinel-meta.json");
  await fs.writeFile(
    metaPath,
    JSON.stringify({
      version: 1,
      meta: { handoffId: "fixture-handoff", triageContextPath: contextPath },
    }),
  );
  Object.assign(target.env, {
    OPENCLAW_UPDATE_RUN_HANDOFF: "1",
    [CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
  });
  return { target, contextPath };
}

beforeEach(() => {
  triageAfterFailure.mockClear();
  reportActionSelect.mockReset();
  reportActionSelect.mockResolvedValue("triage");
  for (const method of ["exit", "log", "error", "writeJson"] as const) {
    vi.spyOn(defaultRuntime, method).mockImplementation(() => undefined);
  }
});

afterEach(() => vi.restoreAllMocks());

it.each([
  { opts: { yes: true }, terminal: true, flag: "--non-interactive" },
  { opts: { json: true }, terminal: true, flag: "--json" },
  { opts: {}, terminal: false, flag: "--non-interactive" },
])(
  "collects diagnostics without repair admission ($opts, TTY=$terminal)",
  async ({ opts, terminal, flag }) => {
    const result = { ...failedUpdate, reason: "restart-unhealthy" };
    const target = await createInstalledTriage(true);
    await withTriageTerminal(terminal, async () => {
      await expect(
        withUpdateFailureTriage(opts, target, async () => {
          try {
            defaultRuntime.writeJson(result);
            throw new UpdateCommandFailure(result);
          } finally {
            await fs.writeFile(path.join(target.root, "released"), "done");
          }
        }),
      ).rejects.toMatchObject({ code: 1 });
    });
    const receipt = await readReceipt(target);
    expect(receipt).toMatchObject({
      released: true,
      args: ["triage", "--update-result", expect.any(String), flag],
      stateDir: target.env.OPENCLAW_STATE_DIR,
      configPath: target.env.OPENCLAW_CONFIG_PATH,
      failure: { result: { mode: "npm", reason: result.reason, before: { version: "2026.8.1" } } },
    });
    expect(receipt.updateInProgress).toBeUndefined();
    expect(receipt.serviceMarker).toBeUndefined();
    expect(JSON.stringify(receipt.failure)).toContain("ENOSPC");
    expect(defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(result);
    if ("json" in opts) {
      expectNoCalls(defaultRuntime.log);
      expectMessages(defaultRuntime.error, '"promptPath":');
    }
    const output = [
      ...vi.mocked(defaultRuntime.log).mock.calls,
      ...vi.mocked(defaultRuntime.error).mock.calls,
    ]
      .flat()
      .join("\n");
    expect(output).toContain("openclaw triage --run --update-result");
    expect(output).toContain("Triage diagnostics saved; no repair agent was started.");
    expectNoCalls(defaultRuntime.exit, triageAfterFailure, reportActionSelect);
  },
);

it("preserves non-interactive updater failures", async () => {
  const target: UpdateTriageTarget & { root: string } = await createInstalledTriage();
  const failure = new Error("Package verification failed unexpectedly");
  target.failureResult = {
    ...failedUpdate,
    recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
  };

  await withTriageTerminal(false, async () => {
    await expect(failUpdate(target, { yes: false }, failure)).rejects.toBe(failure);
  });

  const receipt = await readReceipt(target);
  expect(receipt.args).toContain("--non-interactive");
  expect(receipt.failure).toMatchObject({
    error: failure.message,
    result: { recovery: { serviceRestartSafe: false } },
  });
  expectNoCalls(defaultRuntime.exit, reportActionSelect);
});

it("exports the final managed failure after cleanup without launching triage", async () => {
  const { target, contextPath } = await createManagedTriageTarget();
  const result: ReturnType<typeof resultFixture> = {
    ...failedUpdate,
    after: { version: "2026.9.1" },
    recovery: { serviceRestartSafe: true, version: "2026.9.1" },
  };
  const targetWithResult: UpdateTriageTarget = { ...target, failureResult: result };
  await fs.writeFile(contextPath, JSON.stringify({ error: "Stale pre-recovery result" }));
  const secret = "sk-test-managed-triage-secret-1234567890";
  const detail = `Fresh Doctor failed token=${secret}; original Doctor diagnostic`;
  const failure = new UpdateCommandFailure(result, 1, detail);
  const completion = withUpdateFailureTriage({ json: true }, targetWithResult, async () => {
    try {
      throw failure;
    } finally {
      failure.result.recovery = {
        serviceRestartSafe: false,
        reason: "runtime-verification-failed",
      };
      await fs.writeFile(path.join(target.root, "released"), "done");
    }
  });
  await expect(completion).rejects.toMatchObject({ code: 1 });
  const raw = await fs.readFile(contextPath, "utf8");
  expect(JSON.parse(raw)).toMatchObject({
    error: expect.stringContaining("original Doctor diagnostic"),
    result: {
      before: { version: "2026.8.1" },
      after: { version: "2026.9.1" },
      recovery: { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [{ stderrTail: "ENOSPC" }],
    },
  });
  expectMessages(defaultRuntime.error, "openclaw triage --run --update-result");
  expect(raw).not.toContain(secret);
  expect(raw).not.toContain("Stale pre-recovery result");
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(4 * 1024 + 1);
  if (process.platform !== "win32") {
    expect((await fs.stat(contextPath)).mode & 0o777).toBe(0o600);
  }
  await expectNoTriage(target);
  expectNoCalls(defaultRuntime.writeJson, defaultRuntime.log, reportActionSelect);
});

it("leaves the outer managed export untouched in a post-core child", async () => {
  const { target, contextPath } = await createManagedTriageTarget();
  Object.assign(target.env, { [POST_CORE_UPDATE_ENV]: "1" });
  const original = JSON.stringify({ error: "Outer updater owns final recovery" });
  await fs.writeFile(contextPath, original);

  await expect(failUpdate(target)).rejects.toMatchObject({ code: 1 });

  await expect(fs.readFile(contextPath, "utf8")).resolves.toBe(original);
  await expectNoTriage(target);
});

it("leaves triage to the owner for a managed helper child", async () => {
  const target = await createInstalledTriage();
  Object.assign(target.env, { OPENCLAW_UPDATE_RUN_HANDOFF: "1" });
  await expect(
    failUpdate(target, {}, new UpdateCommandFailure(failedUpdate, 80)),
  ).rejects.toMatchObject({ code: 80 });
  await expectNoTriage(target);
  await expectMissing(target.env.OPENCLAW_STATE_DIR);
});

it("uses a new report identity for each distinct CLI update execution", async () => {
  const target = await createInstalledTriage();
  reportActionSelect.mockResolvedValue("dismiss");
  vi.spyOn(configureShared, "confirm").mockResolvedValue(false);
  const prepare = vi.spyOn(updateFailureReport, "prepareUpdateFailureReport");

  await withTriageTerminal(true, async () => {
    for (let index = 0; index < 2; index += 1) {
      reportActionSelect.mockResolvedValueOnce("report");
      await expect(failUpdate(target)).rejects.toMatchObject({ code: 1 });
    }
  });

  const attemptIds = prepare.mock.calls.map(([params]) => params.attemptId);
  expect(attemptIds).toHaveLength(2);
  expect(attemptIds).toEqual(Array(2).fill(expect.stringMatching(/^[0-9a-f-]{36}$/u)));
  expect(attemptIds[0]).not.toBe(attemptIds[1]);
});

it("does not start triage when the report action menu throws", async () => {
  const target = await createInstalledTriage();
  const bin = path.join(target.root, "bin");
  const triageReceipt = path.join(target.root, "triage-receipt");
  await fs.mkdir(bin);
  await fs.writeFile(
    path.join(bin, "claude"),
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(triageReceipt)}, "called");\n`,
    { mode: 0o700 },
  );
  reportActionSelect.mockRejectedValue(new Error("report storage unavailable"));

  await withEnvAsync({ PATH: bin, HOME: target.root, USERPROFILE: target.root }, () =>
    withTriageTerminal(true, async () => {
      await expect(failUpdate(target)).rejects.toMatchObject({ code: 1 });
    }),
  );

  await expectMissing(triageReceipt);
  expectMessages(defaultRuntime.error, "report storage unavailable");
});

it("preserves the original failure when diagnostics cannot be written", async () => {
  const target = await createInstalledTriage();
  await fs.writeFile(target.env.OPENCLAW_STATE_DIR, "not a directory");
  const failure = new Error("Original update failure");
  await expect(failUpdate(target, {}, failure)).rejects.toBe(failure);
  expectMessages(defaultRuntime.error, "Triage could not complete:");
  await expectMissing(path.join(target.root, "receipt.json"));
});

it
  .skipIf(process.platform === "win32")
  .each([
    { stateFailure: "missing", removeCwd: false, agentExitCode: 0 },
    { stateFailure: "missing", removeCwd: true, agentExitCode: 0 },
    { stateFailure: "missing", removeCwd: false, agentExitCode: 23 },
    ...(process.getuid?.() === 0
      ? []
      : [{ stateFailure: "unsearchable", removeCwd: false, agentExitCode: 0 }]),
  ])(
  "starts native recovery outside an unusable state directory ($stateFailure, removed cwd=$removeCwd, agent exit=$agentExitCode)",
  async ({ stateFailure, removeCwd, agentExitCode }) => {
    vi.mocked(defaultRuntime.exit).mockImplementation((code) => {
      throw new ExitError(code);
    });
    await withOpenClawTestState({ layout: "split" }, async (state) => {
      const invocationCwd = state.path("operator-shell");
      const brokenStateDir = state.path("unusable-state");
      const receiptPath = state.path("agent-receipts.jsonl");
      const releasedPath = state.path("released");
      const bin = state.path("bin");
      const secret = "sk-test-triage-recovery-secret-1234567890";
      await fs.mkdir(invocationCwd);
      await fs.mkdir(bin);
      if (stateFailure === "missing") {
        await fs.symlink(state.path("unavailable-state-volume"), brokenStateDir, "dir");
      } else {
        await fs.mkdir(brokenStateDir, { mode: 0o600 });
      }
      try {
        await expect(fs.access(brokenStateDir, fs.constants.X_OK)).rejects.toMatchObject({
          code: stateFailure === "missing" ? "ENOENT" : "EACCES",
        });
        await fs.writeFile(
          path.join(bin, "claude"),
          `#!${process.execPath}\n` +
            `const fs = require("node:fs");\n` +
            `if (process.argv.includes("--help")) { process.stdout.write("--safe-mode\\n"); process.exit(0); }\n` +
            `fs.appendFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({\n` +
            `  cwd: fs.realpathSync(process.cwd()),\n` +
            `  home: process.env.HOME,\n` +
            `  stateDir: process.env.OPENCLAW_STATE_DIR,\n` +
            `  configPath: process.env.OPENCLAW_CONFIG_PATH,\n` +
            `  workspaceDir: process.env.OPENCLAW_WORKSPACE_DIR,\n` +
            `  path: process.env.PATH,\n` +
            `  nodeOptions: process.env.NODE_OPTIONS,\n` +
            `  updateInProgress: process.env.OPENCLAW_UPDATE_IN_PROGRESS,\n` +
            `  released: fs.existsSync(${JSON.stringify(releasedPath)}),\n` +
            `  prompt: process.argv.at(-1),\n` +
            `}) + "\\n");\n` +
            `process.exitCode = ${agentExitCode};\n`,
          { mode: 0o700 },
        );
        await withEnvAsync(
          {
            PATH: bin,
            NODE_OPTIONS: "--no-warnings",
            OPENCLAW_WORKSPACE_DIR: state.workspaceDir,
          },
          () =>
            withTriageTerminal(true, async () => {
              const target: UpdateTriageTarget = { env: { ...process.env } };
              await expect(
                withUpdateFailureTriage({ invocationCwd }, target, async () => {
                  try {
                    if (removeCwd) {
                      await fs.rmdir(invocationCwd);
                    }
                    target.root = state.path("unavailable-installed-package");
                    target.env = {
                      ...target.env,
                      HOME: state.path("service-home"),
                      PATH: state.path("service-tools"),
                      NODE_OPTIONS: "--trace-warnings",
                      OPENCLAW_STATE_DIR: brokenStateDir,
                      OPENCLAW_UPDATE_IN_PROGRESS: "1",
                    };
                    process.env.HOME = state.path("later-home");
                    process.env.USERPROFILE = state.path("later-home");
                    process.env.PATH = state.path("later-tools");
                    process.env.NODE_OPTIONS = "--trace-warnings";
                    throw new UpdateCommandFailure(
                      {
                        ...failedUpdate,
                        root: target.root,
                        reason: "injected-doctor-failure",
                        recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
                        steps: [stepFixture("doctor", { stderrTail: "State migration failed" })],
                      },
                      7,
                      `Doctor failed; Authorization: Bearer ${secret}`,
                    );
                  } finally {
                    await fs.writeFile(releasedPath, "done");
                  }
                }),
              ).rejects.toMatchObject({ code: 7 });
            }),
        );
        const receipts = (await fs.readFile(receiptPath, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(receipts).toMatchObject([
          {
            cwd: removeCwd ? state.home : invocationCwd,
            home: state.home,
            stateDir: brokenStateDir,
            configPath: state.configPath,
            workspaceDir: state.workspaceDir,
            path: bin,
            nodeOptions: "--no-warnings",
            released: true,
            prompt: expect.stringContaining("injected-doctor-failure"),
          },
        ]);
        expect(receipts[0].updateInProgress).toBeUndefined();
        expect(receipts[0].prompt).not.toContain(secret);
        expectMessages(defaultRuntime.error, "Debugging prompt could not be saved:");
        expect(defaultRuntime.log).not.toHaveBeenCalledWith(
          expect.stringMatching(/^Debugging prompt: /u),
        );
        if (agentExitCode !== 0) {
          expectMessages(defaultRuntime.error, `Triage exited with code ${agentExitCode}`);
        }
        expect(defaultRuntime.exit).not.toHaveBeenCalled();
      } finally {
        if (stateFailure === "unsearchable") {
          await fs.chmod(brokenStateDir, 0o700);
        }
      }
    });
  },
);
