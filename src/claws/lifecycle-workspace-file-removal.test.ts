import { describe, expect, it } from "vitest";
import type { RemovedWorkspaceFile } from "./lifecycle-remove-types.js";
import type { ClawStatusRecord } from "./lifecycle-status.js";
import { applyClawWorkspaceFileRemovals } from "./lifecycle-workspace-file-removal.js";

describe("applyClawWorkspaceFileRemovals", () => {
  it("publishes completed outcomes before the next file fence check fails", async () => {
    const record = {
      workspaceOrigin: { adopted: false },
      workspaceFiles: [
        { workspace: "unused", path: "first.md", state: "missing" },
        { workspace: "unused", path: "second.md", state: "missing" },
      ],
    } as unknown as ClawStatusRecord;
    const results: RemovedWorkspaceFile[] = [];
    let assertions = 0;

    await expect(
      applyClawWorkspaceFileRemovals(
        record,
        false,
        () => {
          assertions += 1;
          if (assertions === 2) {
            throw new Error("lost removal fence");
          }
        },
        results,
      ),
    ).rejects.toThrow("lost removal fence");

    expect(results).toEqual([{ path: "first.md", action: "missing" }]);
  });
});
