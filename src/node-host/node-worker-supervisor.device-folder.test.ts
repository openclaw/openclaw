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
  testWorkerLaunchInput,
  writeNodeWorkerFixture,
} from "./node-worker-supervisor.test-support.js";
import { NodeWorkerTurnStore } from "./node-worker-turn-store.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const tempDirs = useStateDatabaseTempDirs();

function fixture() {
  const value = writeNodeWorkerFixture(tempDirs.make("device-folder-launch-"));
  const folder = fs.realpathSync.native(value.workspaceDir);
  const allowed = path.dirname(folder);
  const workspace = new NodeWorkerWorkspaceRuntime({
    root: value.bundleRoot,
    env: value.env,
    folders: [allowed],
  });
  const supervisor = createNodeWorkerSupervisor({ ...value, workspace });
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
    launch,
    retarget,
    afterJournal,
    expectUntouched: () => expect(fs.readdirSync(replacement)).toEqual([]),
    [Symbol.asyncDispose]: () => supervisor.close(),
  };
}

describe("device-folder launch fencing", () => {
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
