import fs from "node:fs";
import { Readable } from "node:stream";
import { expect, it, vi } from "vitest";
import * as rootOwner from "../../infra/openclaw-root.js";
import { withInitialStoreFixture } from "../update-cli/update-command-initial-store.test-support.js";
import { runGatewayServiceUpdateCommand } from "./update-executor.js";

it("refuses a replaced initial state before native package discovery or action", async () => {
  await withInitialStoreFixture(async ({ installation, input }) => {
    const statePath = input.selection.state.databasePath;
    const before = fs.readFileSync(statePath);
    fs.renameSync(statePath, statePath + ".retained");
    fs.writeFileSync(statePath, before, { mode: 0o600 });
    const discovery = vi
      .spyOn(rootOwner, "resolveOpenClawPackageRoot")
      .mockImplementation(async () => {
        throw new Error("package discovery reached");
      });
    const action = vi.fn(async () => {});
    // Intentionally only the outer transport shape: physical-store admission
    // must precede package discovery and full native grant admission.
    const stdin = Readable.from([
      JSON.stringify({
        action: "restart",
        targetRoot: installation,
        executor: {
          runId: "daemon-initial-store",
          root: installation,
          databasePath: input.selection.handoff.databasePath,
          childKey: installation + "/.openclaw-update-child-stores-v1-lineage-test",
          parent: {},
          originalParent: {},
          databaseIdentity: {},
          originalChildKey: "original-child",
          spawner: {},
          initialStores: { protocol: "initial-pair-v1", selection: input.selection },
        },
      }),
    ]);
    const descriptor = Object.getOwnPropertyDescriptor(process, "stdin");
    if (!descriptor) {
      throw new Error("Missing process stdin fixture descriptor");
    }
    try {
      Object.defineProperty(process, "stdin", { configurable: true, value: stdin });
      await expect(runGatewayServiceUpdateCommand("run", "restart", action)).rejects.toThrow(
        "UPDATE_NATIVE_AUTHORITY: Update initial store admission refused: database generation changed",
      );
      expect(discovery).not.toHaveBeenCalled();
      expect(action).not.toHaveBeenCalled();
      expect(fs.readFileSync(statePath)).toEqual(before);
      expect(fs.readFileSync(statePath + ".retained")).toEqual(before);
    } finally {
      Object.defineProperty(process, "stdin", descriptor);
      stdin.destroy();
    }
  });
});
