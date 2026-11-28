import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  loadExecApprovals,
  loadExecApprovalsReadOnlyAsync,
  readExecApprovalsSnapshot,
  readExecApprovalsSnapshotAsync,
  type ExecApprovalsFile,
} from "../plugin-sdk/exec-approvals-runtime.js";
import {
  closeOpenClawStateDatabaseAsync,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { updateExecApprovals } from "./exec-approvals-store.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    cleanup();
  }),
);

beforeEach(async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-sdk-approval-compat-"));
  openOpenClawStateDatabase();
  await updateExecApprovals({
    update: {
      kind: "replace",
      file: {
        version: 1,
        defaults: { security: "allowlist" },
        agents: { main: { allowlist: [{ id: "initial", pattern: "/usr/bin/echo" }] } },
      },
    },
  });
});

const readers: { name: string; read: () => ExecApprovalsFile | Promise<ExecApprovalsFile> }[] = [
  { name: "deprecated loadExecApprovals", read: loadExecApprovals },
  { name: "deprecated readExecApprovalsSnapshot", read: () => readExecApprovalsSnapshot().file },
  {
    name: "readExecApprovalsSnapshotAsync",
    read: async () => (await readExecApprovalsSnapshotAsync()).file,
  },
];

it.each(readers)(
  "lets SDK callers edit and save $name without mutating live policy",
  async ({ read }) => {
    const retained = await loadExecApprovalsReadOnlyAsync();
    const draft = await read();
    draft.defaults!.security = "deny";
    draft.agents!.main!.allowlist![0]!.pattern = "/usr/bin/printf";
    draft.agents!.main!.allowlist!.push({ id: "added", pattern: "/usr/bin/true" });

    expect(await loadExecApprovalsReadOnlyAsync()).toBe(retained);
    expect(retained.defaults?.security).toBe("allowlist");
    expect(retained.agents?.main?.allowlist).toEqual([{ id: "initial", pattern: "/usr/bin/echo" }]);

    await updateExecApprovals({ update: { kind: "replace", file: draft } });
    const saved = await read();
    expect(saved.defaults?.security).toBe("deny");
    expect(saved.agents?.main?.allowlist).toEqual([
      { id: "initial", pattern: "/usr/bin/printf" },
      { id: "added", pattern: "/usr/bin/true" },
    ]);
    expect(retained.defaults?.security).toBe("allowlist");
  },
);
