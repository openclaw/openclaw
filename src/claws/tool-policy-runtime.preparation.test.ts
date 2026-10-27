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

async function consentFixture(stateDir: string, lateRegistration = false) {
  vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
  const params = {
    agentId: "worker",
    agentTools: { profile: "full" as const, allow: ["read"] },
    hasAgentAllowlist: true,
    ownsProfile: true,
    profile: "full",
  };
  const config = { agents: { entries: { worker: { tools: params.agentTools } } } };
  if (lateRegistration) {
    setRuntimeConfigSnapshot(config);
  }
  const { resolveClawToolPolicyConsent } = await import("./tool-policy-runtime.js");
  return { config, resolve: () => resolveClawToolPolicyConsent(params) };
}
const installRow = (schemaVersion: string, agentConfigDigest: string) => ({
  agentId: "worker",
  schemaVersion,
  agentConfigDigest,
});

it("defers late-registered consent reads until awaited config preparation", async () => {
  const { config, resolve } = await consentFixture("/claw-consent-late-registration", true);
  const candidate = collectClawToolPolicyCandidates(config)[0]!;
  expect(worker.mainRead).not.toHaveBeenCalled();
  expect(worker.read).not.toHaveBeenCalled();
  expect(resolve).toThrow("Cannot verify the installed tool authority");

  const rows = Promise.withResolvers<ClawInstallSchemaVersionRow[]>();
  worker.read.mockReturnValueOnce(rows.promise);
  const preparing = setAppliedRuntimeConfigSnapshot(config, config);
  expect(worker.read).toHaveBeenCalledOnce();
  expect(resolve).toThrow("Cannot verify the installed tool authority");
  rows.resolve([installRow(CLAW_INSTALL_RECORD_SCHEMA_VERSION, candidate.agentConfigDigest)]);
  await preparing;

  expect(resolve()).toEqual({ frozen: true });
  expect(worker.mainRead).not.toHaveBeenCalled();
});

it("keeps legacy installed-Claw tool authority fail-closed without an update command", async () => {
  const { config, resolve } = await consentFixture("/claw-consent-legacy");
  worker.read.mockResolvedValueOnce([installRow("openclaw.clawInstallRecord.v1", "old-grant")]);

  await setAppliedRuntimeConfigSnapshot(config, config);

  expect(resolve).toThrow("Add the Claw again to create an ordinary agent");
  expect(worker.mainRead).not.toHaveBeenCalled();
});
