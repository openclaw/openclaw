import { afterEach, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setAppliedRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { ClawInstallSchemaVersionRow } from "./provenance-runtime-read.kernel.js";
import { CLAW_INSTALL_RECORD_SCHEMA_VERSION } from "./provenance-schema-version.js";
import { collectClawToolPolicyCandidates } from "./tool-policy-candidates.js";

const worker = vi.hoisted(() => ({
  read: vi.fn<() => Promise<ClawInstallSchemaVersionRow[]>>(),
  mainRead: vi.fn(() => {
    throw new Error("Consent registration must not read SQLite on the main thread");
  }),
}));

// mock-isolation: Hold the worker response pending to observe the consent publication boundary.
vi.mock("../state/openclaw-state-worker-store.js", () => ({
  runOpenClawStateWorkerOperation: worker.read,
}));
// mock-isolation: Synthetic admission keeps this publication test independent of host database state.
vi.mock("../state/openclaw-state-worker-context.js", () => ({
  captureOpenClawStateWorkerContext: () => ({ admission: { assertCurrent() {} } }),
}));
// mock-isolation: Trap every synchronous read so consent registration cannot silently use SQLite.
vi.mock("../state/openclaw-state-db-readonly.js", () => ({
  isArtifactPreservingStateRead: () => false,
  withExistingOpenClawStateDatabaseReadOnly: worker.mainRead,
  withExistingOpenClawStateDatabaseArtifactPreservingReadOnly: worker.mainRead,
}));

afterEach(() => {
  clearRuntimeConfigSnapshot();
  vi.unstubAllEnvs();
});

it("defers late-registered consent reads until awaited config preparation", async () => {
  vi.stubEnv("OPENCLAW_STATE_DIR", "/claw-consent-late-registration");
  const tools = { profile: "full" as const, allow: ["read"] };
  const config = { agents: { entries: { worker: { tools } } } };
  const candidate = collectClawToolPolicyCandidates(config)[0]!;
  setRuntimeConfigSnapshot(config);

  const { resolveClawToolPolicyConsent } = await import("./tool-policy-runtime.js");
  const resolve = () =>
    resolveClawToolPolicyConsent({
      agentId: "worker",
      agentTools: tools,
      hasAgentAllowlist: true,
      ownsProfile: true,
      profile: "full",
    });
  expect(worker.mainRead).not.toHaveBeenCalled();
  expect(worker.read).not.toHaveBeenCalled();
  expect(resolve).toThrow("Cannot verify the installed tool authority");

  const rows = Promise.withResolvers<ClawInstallSchemaVersionRow[]>();
  worker.read.mockReturnValueOnce(rows.promise);
  const preparing = setAppliedRuntimeConfigSnapshot(config, config);
  expect(worker.read).toHaveBeenCalledOnce();
  expect(resolve).toThrow("Cannot verify the installed tool authority");
  rows.resolve([
    {
      agentId: "worker",
      schemaVersion: CLAW_INSTALL_RECORD_SCHEMA_VERSION,
      agentConfigDigest: candidate.agentConfigDigest,
    },
  ]);
  await preparing;

  expect(resolve()).toEqual({ frozen: true });
  expect(worker.mainRead).not.toHaveBeenCalled();
});
