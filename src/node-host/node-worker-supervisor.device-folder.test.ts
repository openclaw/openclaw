import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
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
afterEach(() => vi.restoreAllMocks());

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
  const input = (id: string, prompt = "success") => ({
    ...testWorkerLaunchInput(folder, id, prompt),
    sessionKey: "session-1",
  });
  const retarget = () => {
    fs.renameSync(folder, `${folder}-original`);
    const replacement = path.join(allowed, "replacement");
    fs.mkdirSync(replacement);
    fs.symlinkSync(replacement, folder, "dir");
    return replacement;
  };
  return { supervisor, folder, input, retarget };
}

describe("device-folder launch fencing", () => {
  it("rejects a folder retargeted while capacity acquisition was waiting", async () => {
    const { supervisor, input, retarget } = fixture();
    const acquired = createDeferred();
    const resume = createDeferred();
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
    const launch = supervisor.launch(input("capacity-wait"), TEST_WORKER_ENDPOINT);
    const settled = launch.then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await Promise.race([
        acquired.promise,
        launch.then(() => {
          throw new Error("Launch ended before capacity acquisition");
        }),
      ]);
      const replacement = retarget();
      resume.resolve();
      expect(await settled).toBeInstanceOf(Error);
      expect(String(await settled)).toContain("acquired device folder changed");
      expect(prepare).not.toHaveBeenCalled();
      expect(fs.readdirSync(replacement)).toEqual([]);
    } finally {
      resume.resolve();
      await supervisor.close();
    }
  });

  it("rechecks after first-turn journaling before preparing a child", async () => {
    const { supervisor, input, retarget } = fixture();
    // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the original receiver.
    const originalClaim = NodeWorkerTurnStore.prototype.claim;
    const claim = vi.spyOn(NodeWorkerTurnStore.prototype, "claim");
    let replacement = "";
    claim.mockImplementation(async function (this: NodeWorkerTurnStore, ...args) {
      const result = await originalClaim.apply(this, args);
      replacement = retarget();
      return result;
    });
    const prepare = vi.spyOn(transport, "prepareNodeWorkerLaunchTransport");
    try {
      const receipt = await supervisor.launch(input("journal-wait"), TEST_WORKER_ENDPOINT);
      expect(receipt).toMatchObject({
        state: "failed",
        errorText: expect.stringContaining("acquired device folder changed"),
      });
      expect(prepare).not.toHaveBeenCalled();
      expect(fs.readdirSync(replacement)).toEqual([]);
    } finally {
      await supervisor.close();
    }
  });

  it("rechecks after child startup before opening the turn execution gate", async () => {
    const { supervisor, input, retarget } = fixture();
    const prepare = transport.prepareNodeWorkerLaunchTransport;
    let replacement = "";
    vi.spyOn(transport, "prepareNodeWorkerLaunchTransport").mockImplementation(async (options) => {
      const prepared = await prepare(options);
      replacement = retarget();
      return prepared;
    });
    try {
      const receipt = await supervisor.launch(input("startup-wait"), TEST_WORKER_ENDPOINT);
      expect(receipt).toMatchObject({
        state: "failed",
        errorText: expect.stringContaining("acquired device folder changed"),
      });
      expect(fs.readdirSync(replacement)).toEqual([]);
    } finally {
      await supervisor.close();
    }
  });

  it("rechecks a retained child's folder after journaling its next turn", async () => {
    const { supervisor, input, retarget } = fixture();
    try {
      await supervisor.launch(input("first", "diagnostic-retain"), TEST_WORKER_ENDPOINT);
      expect((await waitForNodeWorkerTerminal(supervisor, "first")).state).toBe("completed");
      // oxlint-disable-next-line typescript/unbound-method -- apply below preserves the original receiver.
      const originalClaim = NodeWorkerTurnStore.prototype.claim;
      const claim = vi.spyOn(NodeWorkerTurnStore.prototype, "claim");
      let replacement = "";
      claim.mockImplementation(async function (this: NodeWorkerTurnStore, ...args) {
        const result = await originalClaim.apply(this, args);
        replacement = retarget();
        return result;
      });
      const receipt = await supervisor.launch(input("reused"), TEST_WORKER_ENDPOINT);
      expect(receipt.state).toBe("interrupted");
      expect(receipt.errorText).toContain("acquired device folder changed");
      expect(fs.readdirSync(replacement)).toEqual([]);
    } finally {
      await supervisor.close();
    }
  });
});
