import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
} from "../../test/helpers/fixture-receipts.js";
import { createDeferred, withinTest } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as exec from "../process/exec.js";
import { isPidAlive } from "../shared/pid-alive.js";
import { createCommandResult } from "../test-utils/npm-spec-install-test-helpers.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { UPDATE_RUN_ID_ENV } from "./update-control-plane-sentinel.js";
import { prepareUpdateFailureTriage, runUpdateFailureTriage } from "./update-triage.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(() => receipts?.close());

async function createInstalledTriage(params: { hang?: boolean; promptPath?: string } = {}) {
  const root = await fs.realpath(tempDirs.make("openclaw-triage-child-"));
  const receiptPath = path.join(root, "receipt.json");
  const promptPath = params.promptPath ?? path.join(root, "triage-prompt.md");
  await fs.mkdir(path.join(root, "dist"));
  await fs.writeFile(
    path.join(root, "dist", "index.js"),
    `
    ${fixtureReceiptClientSource(receipts.endpoint).replace(
      'import { createConnection as connectFixtureReceipts } from "node:net";',
      'const { createConnection: connectFixtureReceipts } = require("node:net");',
    )}
    const fs = require("node:fs");
    fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({ pid: process.pid, updateRunId: process.env[${JSON.stringify(UPDATE_RUN_ID_ENV)}] ?? null }));
    sendReceipt(${JSON.stringify(receiptPath)}, "ready");
    ${params.hang ? "setInterval(() => {}, 1000);" : `process.stdout.write(JSON.stringify({ promptPath: ${JSON.stringify(promptPath)}, bundlePath: null, bundleError: "Snapshot unavailable" }));`}
  `,
  );
  const target = {
    root,
    nodeRunner: process.execPath,
    env: { HOME: root, USERPROFILE: root, OPENCLAW_STATE_DIR: path.join(root, "state") },
  };
  const runtime = { log: vi.fn(), error: vi.fn() };
  const run = (overrides: Partial<Parameters<typeof runUpdateFailureTriage>[0]> = {}) =>
    runUpdateFailureTriage({
      failure: { error: "Update failed" },
      mode: "json",
      runtime,
      target,
      ...overrides,
    });
  return { receiptPath, promptPath, target, runtime, run };
}

describe("update triage child lifecycle", () => {
  it.each(["abort", "owner closure"] as const)(
    "does not start prepared interactive triage after %s during cwd validation",
    async (closure) => {
      await withOpenClawTestState({ layout: "split" }, async (state) => {
        const triage = await import("../commands/triage.js");
        const handoff = vi.spyOn(triage, "triageCommand").mockResolvedValue();
        const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
        const prepared = await prepareUpdateFailureTriage({
          mode: "interactive",
          runtime,
          invocationCwd: state.workspaceDir,
        });
        const cwdStat = await fs.stat(state.workspaceDir);
        const { promise: validating, resolve: started } = createDeferred();
        const blocked = createDeferred();
        vi.spyOn(fs, "stat").mockImplementationOnce(async () => {
          started();
          await blocked.promise;
          return cwdStat;
        });
        const controller = new AbortController();
        let current = true;
        const pending = prepared({
          failure: { error: "Update failed" },
          target: { env: { ...process.env } },
          signal: controller.signal,
          isCurrent: () => current,
        });
        await validating;
        if (closure === "abort") {
          controller.abort();
        } else {
          current = false;
        }
        blocked.resolve();
        expect(await pending).toEqual({ status: "cancelled" });
        expect(handoff).not.toHaveBeenCalled();
        expect(runtime.error).not.toHaveBeenCalled();
      });
    },
  );

  it("keeps artifact paths in local output and returns the partial-export outcome", async () => {
    const { target, promptPath, receiptPath, runtime, run } = await createInstalledTriage();
    const result = await run({
      target: { ...target, env: { ...target.env, [UPDATE_RUN_ID_ENV]: "completed-update-run" } },
      failure: { error: "Update could not install the package" },
    });
    expect(result).toMatchObject({
      status: "completed",
      hint: expect.stringContaining("Diagnostics export unavailable: Snapshot unavailable"),
    });
    expect("hint" in result && result.hint).not.toContain(target.root);
    expect(runtime.log).toHaveBeenCalledWith(
      JSON.stringify({ promptPath, bundlePath: null, bundleError: "Snapshot unavailable" }),
    );
    expect(runtime.log).toHaveBeenCalledWith("Preparing triage diagnostics...");
    expect(runtime.log).not.toHaveBeenCalledWith("Update failed. Entering triage...");
    expect(runtime.error).not.toHaveBeenCalled();
    expect(JSON.parse(await fs.readFile(receiptPath, "utf8"))).toMatchObject({ updateRunId: null });
  });

  it("does not launch diagnostics after its owner closes during root discovery", async () => {
    const { target, receiptPath, run } = await createInstalledTriage();
    const root = createDeferred<string>();
    const { promise: discovering, resolve: started } = createDeferred();
    let current = true;
    const pending = run({
      target: { ...target, root: undefined },
      resolveRoot: () => {
        started();
        return root.promise;
      },
      isCurrent: () => current,
    });
    await discovering;
    current = false;
    root.resolve(target.root);
    expect(await pending).toEqual({ status: "cancelled" });
    await expect(fs.stat(receiptPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("terminates diagnostics and suppresses publication when its scheduler stops", async ({
    signal,
  }) => {
    const { receiptPath, runtime, run } = await createInstalledTriage({ hang: true });
    const controller = new AbortController();
    const pending = run({ signal: controller.signal });
    try {
      // The child writes its record before replying; receipt delivery and command exit are unordered.
      const settled = pending.then(async () => {
        expect(await fs.readFile(receiptPath, "utf8")).not.toBe("");
      });
      await withinTest(Promise.race([receipts.waitFor(receiptPath, "ready"), settled]), signal);
      const { pid } = JSON.parse(await fs.readFile(receiptPath, "utf8")) as { pid: number };
      controller.abort();
      expect(await pending).toEqual({ status: "cancelled" });
      // Command settlement includes its process-tree cleanup join.
      expect(isPidAlive(pid)).toBe(false);
      expect(runtime.log).toHaveBeenCalledWith("Preparing triage diagnostics...");
      expect(runtime.log).toHaveBeenCalledWith(
        expect.stringContaining("openclaw triage --run --update-result"),
      );
      expect(runtime.log).not.toHaveBeenCalledWith(
        "Triage diagnostics saved; no repair agent was started.",
      );
      expect(runtime.error).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await pending;
    }
  });

  it.each(["timeout with zero exit", "empty report path"])("rejects %s", async (failure) => {
    const timeout = failure === "timeout with zero exit";
    const { promptPath, run } = await createInstalledTriage(timeout ? {} : { promptPath: "" });
    if (timeout) {
      vi.spyOn(exec, "runCommandWithTimeout").mockResolvedValueOnce(
        createCommandResult({
          stdout: JSON.stringify({ promptPath }),
          killed: true,
          termination: "timeout",
        }),
      );
    }
    expect(await run()).toMatchObject({
      status: "failed",
      hint: expect.stringContaining(timeout ? "Triage stopped (timeout)" : "openclaw triage"),
    });
  });

  it("redacts and bounds diagnostic failures while preserving an executable Windows host command", async () => {
    const { target, runtime, run } = await createInstalledTriage();
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    target.env.OPENCLAW_STATE_DIR = path.join(target.root, "state directory's");
    const configPath = path.join(target.root, "custom config.json");
    const workspaceDir = path.join(target.root, "custom workspace");
    const targetEnv = {
      ...target.env,
      OPENCLAW_CONFIG_PATH: configPath,
      OPENCLAW_WORKSPACE_DIR: workspaceDir,
    };
    const credential = "synthetic-triage-bearer-value";
    const runCommand = vi
      .spyOn(exec, "runCommandWithTimeout")
      .mockRejectedValueOnce(
        new Error(`ENOSPC Authorization: Bearer ${credential}\n${"detail ".repeat(1000)}`),
      );
    const result = await run({ target: { ...target, env: targetEnv } });
    expect(result).toMatchObject({ status: "failed", hint: expect.stringContaining("ENOSPC") });
    expect(JSON.stringify(result)).not.toContain(credential);
    if (result.status === "failed") {
      const guidance = runtime.log.mock.calls.flat().join("\n");
      expect(result.hint).not.toContain(target.root);
      expect(result.hint.split("\n")[0]?.length).toBeLessThan(284);
      const args = runCommand.mock.calls[0]![0];
      expect(args.slice(-3)).toEqual(["--update-result", expect.any(String), "--json"]);
      const contextPath = args.at(-2)!;
      expect(guidance).toContain(
        `& openclaw triage --update-result '${contextPath.replaceAll("'", "''")}'`,
      );
      for (const selector of [targetEnv.OPENCLAW_STATE_DIR, configPath, workspaceDir]) {
        expect(guidance).toContain(`'${selector.replaceAll("'", "''")}'`);
      }
      await expect(fs.stat(contextPath)).resolves.toMatchObject({ size: expect.any(Number) });
    }
  });
});
