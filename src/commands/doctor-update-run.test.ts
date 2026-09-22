import { afterEach, expect, it, vi } from "vitest";
import { note } from "../../packages/terminal-core/src/note.js";
import { listUpdateRunsAsync } from "../infra/update-run-reader.js";
import type { UpdateRunRecord } from "../infra/update-run-record.js";
import { noteStaleUpdateRuns } from "./doctor-update-run.js";

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: vi.fn() }));
vi.mock("../infra/update-run-reader.js", () => ({ listUpdateRunsAsync: vi.fn() }));
vi.mock("../infra/update-run-interruption.js", async (original) => ({
  ...(await original<typeof import("../infra/update-run-interruption.js")>()),
  reconcileInterruptedUpdateRuns: async () => [],
}));

afterEach(() => vi.resetAllMocks());

it.each([
  {
    reason: "node-runtime-preflight",
    nextAction: [
      "openclaw@2026.9.4 requires Node >=24.16.0; selected runtime is Node 22.23.2.",
      "Recovery:",
      "1. Use the same service account and keep the existing OPENCLAW_STATE_DIR and OPENCLAW_CONFIG_PATH overrides throughout recovery.",
      "2. Run `nvm install 24.16.0 && nvm use 24.16.0`.",
      "3. Run `node /original/openclaw/openclaw.mjs update --tag 2026.9.4`.",
    ].join("\n"),
  },
  {
    reason: "global-install-foreign-destination",
    nextAction:
      "Selected npm destination /other-prefix is occupied by another OpenClaw installation: launcher /other-prefix/bin/openclaw. No selected managed service claims this destination. Switch the runtime back and run `node /original/openclaw/openclaw.mjs update`.",
  },
  { reason: "global-install-foreign-destination", nextAction: undefined },
  {
    reason: "global-install-permission-denied",
    nextAction:
      "Cannot write /opt/openclaw-prefix/lib/node_modules (owned by root); run the package update as the directory's owning account. Pull or build an OpenClaw image with the target version, then recreate or redeploy the container with the same state/config mounts.",
  },
])("keeps $reason remediation visible until a later successful update", async (failure) => {
  let latest: UpdateRunRecord = {
    runId: "6631ecee-adbf-41e8-a0e3-1b88b28b0a59",
    createdAtMs: 1,
    updatedAtMs: 2,
    trigger: "cli",
    phase: "finished",
    status: "failed",
    reason: failure.reason,
    origin: { nextAction: failure.nextAction },
    target: { kind: "package", version: "2026.9.4" },
    before: { version: "2026.7.1-2" },
    after: {},
    steps: [{ step: failure.reason, status: "failed", detail: failure.nextAction }],
    verification: {},
    repair: [],
    confirmedAtMs: null,
    finishedAtMs: 2,
    downtimeMs: null,
  };
  vi.mocked(listUpdateRunsAsync).mockImplementation(async (input) =>
    input?.active ? [] : [latest],
  );

  await noteStaleUpdateRuns({});

  expect(note).toHaveBeenCalledOnce();
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining(`OpenClaw update failed: ${failure.reason}`),
    "Update history",
  );
  expect(note).toHaveBeenCalledWith(
    expect.stringContaining(
      failure.nextAction ??
        "https://docs.openclaw.ai/install/update-troubleshooting#node-and-global-install-permissions",
    ),
    "Update history",
  );

  latest = {
    ...latest,
    runId: "e8a1ac89-4a31-41f6-b401-4b225b661728",
    createdAtMs: 3,
    updatedAtMs: 4,
    finishedAtMs: 4,
    status: "succeeded",
    reason: null,
    origin: {},
    after: { version: "2026.9.4" },
    steps: [],
  };
  vi.mocked(note).mockClear();

  await noteStaleUpdateRuns({});

  expect(note).not.toHaveBeenCalled();
});
