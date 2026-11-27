import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withTriageTerminal } from "../../commands/triage.test-support.js";
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
  // The real child consumes the target environment after the caller unwinds.
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `
    const fs = require("node:fs");
    const path = require("node:path");
    ${rejectRepair ? 'if (process.connected) throw new Error("Unattended update admitted a repair agent");' : ""}
    const args = process.argv.slice(2);
    if (fs.existsSync(process.env.OPENCLAW_STATE_DIR) && !fs.statSync(process.env.OPENCLAW_STATE_DIR).isDirectory()) throw new Error("State directory unavailable");
    fs.writeFileSync(path.join(${JSON.stringify(root)}, "receipt.json"), JSON.stringify({
      args,
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
  Object.assign(target.env, { OPENCLAW_UPDATE_RUN_HANDOFF: "1" });
  return target;
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
      args: ["triage", flag],
      stateDir: target.env.OPENCLAW_STATE_DIR,
      configPath: target.env.OPENCLAW_CONFIG_PATH,
    });
    expect(receipt.updateInProgress).toBeUndefined();
    expect(receipt.serviceMarker).toBeUndefined();
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
    expect(output).toContain("openclaw triage --run");
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
  expectNoCalls(defaultRuntime.exit, reportActionSelect);
});

it("leaves triage to the owner after managed failure cleanup", async () => {
  const target = await createManagedTriageTarget();
  await expect(
    withUpdateFailureTriage({ json: true }, target, async () => {
      try {
        throw new UpdateCommandFailure(failedUpdate);
      } finally {
        await fs.writeFile(path.join(target.root, "released"), "done");
      }
    }),
  ).rejects.toMatchObject({ code: 1 });
  expectMessages(defaultRuntime.error, "openclaw triage --run");
  await expectNoTriage(target);
  expectNoCalls(defaultRuntime.writeJson, defaultRuntime.log, reportActionSelect);
});

it("does not start triage in a post-core child", async () => {
  const target = await createManagedTriageTarget();
  Object.assign(target.env, { [POST_CORE_UPDATE_ENV]: "1" });
  await expect(failUpdate(target)).rejects.toMatchObject({ code: 1 });
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

it("does not start triage when the report action menu throws", async () => {
  const target = await createInstalledTriage();
  reportActionSelect.mockRejectedValue(new Error("report storage unavailable"));

  await withTriageTerminal(true, async () => {
    await expect(failUpdate(target)).rejects.toMatchObject({ code: 1 });
  });
  await expectNoTriage(target);
  expectNoCalls(triageAfterFailure);
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
