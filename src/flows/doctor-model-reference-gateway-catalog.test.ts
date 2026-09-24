// Doctor model-reference checks must trust the running Gateway's published
// inventory, not a catalog rebuilt inside the Doctor process.
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createCoreHealthChecks } from "./doctor-core-checks.js";
import { runCoreHealthFindingNote } from "./doctor-health-contribution-core.js";
import { createDoctorHealthFlowContext } from "./doctor-health-contributions.test-support.js";
import type { HealthCheck } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  loadModelCatalog: vi.fn(async () => [] as readonly { provider: string; id: string }[]),
  callGateway: vi.fn(),
  isImplicitLocalGatewayTarget: vi.fn(async () => false),
  readActiveGatewayLockIdentity: vi.fn(async () => undefined),
  detectExtraGatewayServiceIssues: vi.fn(async () => []),
  extraGatewayServiceToHealthFinding: vi.fn(() => ({})),
  extraGatewayServiceToRepairEffects: vi.fn(() => []),
  collectClawStateHealthFindings: vi.fn(async () => []),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../commands/doctor-gateway-services.js", () => ({
  detectExtraGatewayServiceIssues: mocks.detectExtraGatewayServiceIssues,
  extraGatewayServiceToHealthFinding: mocks.extraGatewayServiceToHealthFinding,
  extraGatewayServiceToRepairEffects: mocks.extraGatewayServiceToRepairEffects,
}));

vi.mock("../claws/doctor.js", () => ({
  collectClawStateHealthFindings: mocks.collectClawStateHealthFindings,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isImplicitLocalGatewayTarget: mocks.isImplicitLocalGatewayTarget,
}));

vi.mock("../infra/gateway-lock.js", () => ({
  readActiveGatewayLockIdentity: mocks.readActiveGatewayLockIdentity,
}));

const runtime = { log() {}, error() {}, exit() {} };
const runtimeOnlyId = "google/gemini-3.8-flash";
const cfg: OpenClawConfig = {
  agents: { defaults: { model: { fallbacks: [runtimeOnlyId] } } },
};

function modelReferenceCheck(): HealthCheck {
  const check = createCoreHealthChecks().find(
    (entry) => entry.id === "core/doctor/model-references",
  );
  if (!check) {
    throw new Error("Missing health check core/doctor/model-references");
  }
  return check;
}

/** A local Gateway the caller can reach, so the published rows are authoritative. */
function withRunningGateway(): void {
  mocks.isImplicitLocalGatewayTarget.mockResolvedValue(true);
  mocks.callGateway.mockReset();
}

describe("doctor model references and the running Gateway catalog", () => {
  it("accepts a runtime-discovered id the running Gateway publishes", async () => {
    withRunningGateway();
    mocks.loadModelCatalog.mockClear();
    mocks.callGateway.mockResolvedValue({
      models: [{ id: "gemini-3.8-flash", provider: "google" }],
    });

    const findings = await modelReferenceCheck().detect({
      mode: "doctor",
      runtime,
      cfg,
      env: { OPENCLAW_GATEWAY_PORT: "18789" },
    });

    expect(findings).not.toContainEqual(expect.objectContaining({ target: runtimeOnlyId }));
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    // The running Gateway owns the inventory; no in-process catalog rebuild.
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it("still reports an id the running Gateway does not publish", async () => {
    withRunningGateway();
    mocks.callGateway.mockResolvedValue({
      models: [{ id: "gemini-2.5-flash", provider: "google" }],
    });

    const findings = await modelReferenceCheck().detect({
      mode: "doctor",
      runtime,
      cfg,
      env: { OPENCLAW_GATEWAY_PORT: "18789" },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({ target: runtimeOnlyId, severity: "info" }),
    );
  });

  it("falls back to cached rows when no local Gateway owns the catalog", async () => {
    mocks.isImplicitLocalGatewayTarget.mockResolvedValue(true);
    mocks.callGateway.mockReset();
    mocks.loadModelCatalog.mockReset();
    mocks.loadModelCatalog.mockResolvedValue([{ provider: "google", id: "gemini-3.8-flash" }]);

    const findings = await modelReferenceCheck().detect({ mode: "doctor", runtime, cfg });

    expect(findings).not.toContainEqual(expect.objectContaining({ target: runtimeOnlyId }));
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.loadModelCatalog).toHaveBeenCalledOnce();
  });

  it("reads a configured remote Gateway instead of rebuilding local rows", async () => {
    mocks.isImplicitLocalGatewayTarget.mockResolvedValue(false);
    mocks.callGateway.mockReset();
    mocks.loadModelCatalog.mockClear();
    mocks.callGateway.mockResolvedValue({
      models: [{ id: "gemini-3.8-flash", provider: "google" }],
    });

    const findings = await modelReferenceCheck().detect({ mode: "doctor", runtime, cfg });

    expect(findings).not.toContainEqual(expect.objectContaining({ target: runtimeOnlyId }));
    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it("keeps the offline verdict when a selected Gateway cannot answer", async () => {
    withRunningGateway();
    mocks.loadModelCatalog.mockClear();
    mocks.callGateway.mockRejectedValue(new Error("gateway unavailable"));

    const findings = await modelReferenceCheck().detect({
      mode: "doctor",
      runtime,
      cfg,
      env: { OPENCLAW_GATEWAY_PORT: "18789" },
    });

    expect(findings).toContainEqual(
      expect.objectContaining({ target: runtimeOnlyId, severity: "info" }),
    );
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });

  it("passes an explicit Gateway port through the ordinary Doctor entry point", async () => {
    withRunningGateway();
    mocks.readActiveGatewayLockIdentity.mockClear();
    mocks.loadModelCatalog.mockClear();
    mocks.callGateway.mockResolvedValue({
      models: [{ id: "gemini-3.8-flash", provider: "google" }],
    });

    await runCoreHealthFindingNote(
      createDoctorHealthFlowContext({ cfg, env: { OPENCLAW_GATEWAY_PORT: "18891" } }),
      "core/doctor/model-references",
    );

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    expect(mocks.readActiveGatewayLockIdentity).not.toHaveBeenCalled();
    expect(mocks.loadModelCatalog).not.toHaveBeenCalled();
  });
});
