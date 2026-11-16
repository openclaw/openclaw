import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { resolveUpdateCaptureRoot } from "../infra/update-capture-paths.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { collectUpdateSnapshotHealthFindings } from "./doctor-update-snapshots.js";

it("lists retained online PostgreSQL captures under the update-capture root", async () => {
  await withOpenClawTestState({ label: "update-snapshots-online" }, async (state) => {
    const snapshot = path.join(
      resolveUpdateCaptureRoot(state.stateDir),
      "online-00000000-0000-4000-8000-000000000003.databases",
    );
    fs.mkdirSync(path.join(snapshot, "agent.sqlite.postgres"), { recursive: true });
    fs.writeFileSync(path.join(snapshot, "agent.sqlite"), "anchor");
    // An unrelated capture-root entry is not a pre-migration snapshot.
    fs.mkdirSync(path.join(resolveUpdateCaptureRoot(state.stateDir), "doctor-unrelated"));
    const findings = await collectUpdateSnapshotHealthFindings(state.env);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.checkId).toBe("core/doctor/update-snapshots");
    expect(findings[0]?.message).toContain("1 retained pre-migration database snapshot directory");
    expect(findings[0]?.message).toContain(snapshot);
    expect(findings[0]?.message).not.toContain("doctor-unrelated");
  });
});
