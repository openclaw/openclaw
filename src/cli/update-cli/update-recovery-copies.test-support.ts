import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import { resolveUpdateCaptureRoot } from "../../infra/update-capture-paths.js";
import {
  UPDATE_CAPTURE_PRIVACY_MARKER,
  UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
} from "../../infra/update-capture-privacy-marker.js";
import { createUpdateRun, finishUpdateRun } from "../../infra/update-run-ledger.js";

/** Sealed copies from successful updates; each later success supersedes the one before. */
export function writeSucceededUpdateCopies(stateDir: string, startedAt: readonly number[]) {
  return startedAt.map((at) => {
    using clock = vi.spyOn(Date, "now");
    clock.mockReturnValue(at);
    const { runId } = createUpdateRun({ trigger: "cli" });
    const directory = path.join(resolveUpdateCaptureRoot(stateDir), runId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(
      path.join(directory, UPDATE_CAPTURE_PRIVACY_MARKER),
      UPDATE_CAPTURE_PRIVACY_MARKER_CONTENT,
    );
    fs.writeFileSync(path.join(directory, "payload"), Buffer.alloc(4096));
    fs.writeFileSync(path.join(directory, "manifest.json"), "{}\n");
    clock.mockReturnValue(at + 1_000);
    finishUpdateRun(runId, { status: "succeeded" });
    return directory;
  });
}
