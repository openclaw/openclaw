import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { NodeWorkerCapacity } from "./node-worker-capacity.js";
import * as transport from "./node-worker-launch-transport.js";
import { waitForNodeWorkerTerminal } from "./node-worker-supervisor.fixture.test-support.js";
import { createNodeWorkerSupervisor } from "./node-worker-supervisor.js";
import {
  TEST_WORKER_ENDPOINT,
  TEST_WORKER_SOURCE,
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { ensureNodeWorkerWorkspaceSessionRoot } from "./node-worker-workspace-identity.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useStateDatabaseTempDirs();

function fixture(filesystemIsolation = false) {
  const value = writeNodeWorkerFixture(tempDirs.make("device-folder-launch-"));
  const folder = fs.realpathSync.native(value.workspaceDir);
  const allowed = path.dirname(folder);
  const workspace = new NodeWorkerWorkspaceRuntime({
    root: value.bundleRoot,
    env: value.env,
    folders: [allowed],
  });
  const supervisor = createNodeWorkerSupervisor({ ...value, workspace, filesystemIsolation });
  const launch = (id: string, prompt = "success") =>
    supervisor.launch(
      { ...testWorkerLaunchInput(folder, id, prompt), sessionKey: "session-1" },
      TEST_WORKER_ENDPOINT,
    );
  const replacement = path.join(allowed, "replacement");
  const retarget = () => {
    fs.renameSync(folder, `${folder}-original`);
    fs.mkdirSync(replacement);
    fs.symlinkSync(replacement, folder, "dir");
  };
  const afterJournal = () => {
    // oxlint-disable-next-line typescript/unbound-method -- apply preserves the original receiver.
    const original = NodeWorkerTurnStore.prototype.claim;
    vi.spyOn(NodeWorkerTurnStore.prototype, "claim").mockImplementation(async function (
      this: NodeWorkerTurnStore,
      ...args
    ) {
      const result = await original.apply(this, args);
      retarget();
      return result;
    });
  };
  return {
    supervisor,
    folder,
    bundleRoot: value.bundleRoot,
    launch,
    retarget,
    afterJournal,
    expectUntouched: () => expect(fs.readdirSync(replacement)).toEqual([]),
    [Symbol.asyncDispose]: () => supervisor.close(),
  };
}

describe("device-folder launch fencing", () => {
  it.runIf(process.platform === "linux")(
    "runs in an approved folder with its assigned private HOME",
    async () => {
      await using context = fixture(true);
      const id = "device-home";
      const input = testWorkerLaunchInput(context.folder, id);
      const worker = path.join(
        context.bundleRoot,
        input.gatewayNamespace,
        "bundles",
        input.expectedBundleHash,
        "worker.mjs",
      );
      fs.writeFileSync(
        worker,
        TEST_WORKER_SOURCE.replace(
          "const mode = descriptor.assignment.prompt;",
          'fs.writeFileSync(path.join(process.env.HOME, "home-proof"), descriptor.assignment.turnId); const mode = descriptor.assignment.prompt;',
        ),
      );
      await context.launch(id);
      expect(await waitForNodeWorkerTerminal(context.supervisor, id)).toMatchObject({
        state: "completed",
      });
      const { environmentId, sessionId, ownerEpoch } = input.descriptor.admission;
      const sessionRoot = ensureNodeWorkerWorkspaceSessionRoot(
        context.bundleRoot,
        input.gatewayNamespace,
        environmentId,
        sessionId,
      );
      const expectedHome = path.join(sessionRoot, String(ownerEpoch), "model-home");
      expect(fs.readFileSync(path.join(expectedHome, "home-proof"), "utf8")).toBe(id);
      expect(fs.existsSync(path.join(context.folder, id + ".started.json"))).toBe(true);
    },
  );

  it("rejects a folder retargeted while capacity acquisition was waiting", async () => {
    await using context = fixture();
    const acquired = createDeferred();
    const resume = createDeferred();
    using release = { [Symbol.dispose]: () => resume.resolve() };
    // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the original receiver.
    const originalClaim = NodeWorkerCapacity.prototype.claim;
    const claim = vi.spyOn(NodeWorkerCapacity.prototype, "claim");
    claim.mockImplementation(async function (this: NodeWorkerCapacity, ...args) {
      const result = await originalClaim.apply(this, args);
      acquired.resolve();
      await resume.promise;
      return result;
    });
    const prepare = vi.spyOn(transport, "prepareNodeWorkerLaunchTransport");
    const launch = context.launch("capacity-wait");
    const settled = launch.catch((error: unknown) => error);
    await awaitGateBeforeSettlement(
      acquired.promise,
      launch,
      "Launch ended before capacity acquisition",
    );
    context.retarget();
    release[Symbol.dispose]();
    expect(await settled).toBeInstanceOf(Error);
    expect(String(await settled)).toContain("acquired device folder changed");
    expect(prepare).not.toHaveBeenCalled();
    context.expectUntouched();
  });

  it.each(["journal", "startup", "retained"] as const)("rechecks after %s", async (stage) => {
    await using context = fixture();
    if (stage === "retained") {
      await context.launch("first", "diagnostic-retain");
      expect((await waitForNodeWorkerTerminal(context.supervisor, "first")).state).toBe(
        "completed",
      );
    }
    const originalPrepare = transport.prepareNodeWorkerLaunchTransport;
    const prepare = vi.spyOn(transport, "prepareNodeWorkerLaunchTransport");
    if (stage === "startup") {
      prepare.mockImplementation(async (options) => {
        const prepared = await originalPrepare(options);
        context.retarget();
        return prepared;
      });
    } else {
      context.afterJournal();
    }
    const receipt = await context.launch("fenced");
    expect(receipt).toMatchObject({
      state: stage === "retained" ? "interrupted" : "failed",
      errorText: expect.stringContaining("acquired device folder changed"),
    });
    if (stage === "journal") {
      expect(prepare).not.toHaveBeenCalled();
    }
    context.expectUntouched();
  });
});
