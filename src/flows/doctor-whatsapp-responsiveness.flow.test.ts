import { beforeEach, expect, it, vi } from "vitest";
import { createDoctorPrompter } from "../commands/doctor-prompter.js";
import {
  createDoctorHealthFlowContext,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";

const mocks = vi.hoisted(() => ({
  note: vi.fn(),
  ps: vi.fn(),
  checkGatewayHealth: vi.fn(),
  probeGatewayMemoryStatus: vi.fn(),
}));
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
vi.mock("./doctor-gateway-exec-credential.js", () => ({
  hasActiveGatewayExecCredential: async () => false,
}));
vi.mock("../commands/doctor-gateway-health.js", () => ({
  checkGatewayHealth: mocks.checkGatewayHealth,
  probeGatewayMemoryStatus: mocks.probeGatewayMemoryStatus,
}));
vi.mock("node:child_process", async () => {
  const { mockNodeChildProcessSpawnSync } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeChildProcessSpawnSync(mocks.ps, () =>
    vi.importActual<typeof import("node:child_process")>("node:child_process"),
  );
});
// Do not mock doctor-whatsapp-responsiveness: its actual owner reads mocked ps
// and queues the advisory through the real contribution runner.

beforeEach(() => vi.clearAllMocks());

it.each([false, true])("keeps CPU advice observational (maintenance=%s)", async (maintenance) => {
  const cfg = { channels: { whatsapp: { enabled: true } } };
  const status = { eventLoop: { degraded: true } };
  const fakePid = process.pid + 1_000_000;
  mocks.ps.mockReturnValue({
    status: 0,
    stdout: `${fakePid} openclaw-tui --profile unrelated\n`,
  });
  mocks.checkGatewayHealth.mockResolvedValue({ healthOk: true, authenticated: false, status });
  const ctx = createDoctorHealthFlowContext({
    cfg,
    env: {},
    options: { repair: maintenance, nonInteractive: true },
    gatewayMaintenanceActive: maintenance,
  });
  ctx.prompter = createDoctorPrompter({ runtime: ctx.runtime, options: ctx.options });
  expect(ctx.prompter.shouldRepair).toBe(maintenance);
  const selected = resolveDoctorHealthContributions().filter((entry) =>
    ["doctor:gateway-health", "doctor:whatsapp-responsiveness"].includes(entry.id),
  );
  using kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("This advisory flow must not signal any process");
  });
  await runDoctorHealthContributionList(ctx, selected);
  const findings =
    ctx.healthFindings?.filter(
      (finding) => finding.checkId === "core/doctor/whatsapp-responsiveness",
    ) ?? [];
  if (maintenance || process.platform === "win32") {
    expect(mocks.ps).not.toHaveBeenCalled();
    expect(findings).toEqual([]);
  } else {
    expect(findings).toEqual([
      expect.objectContaining({
        category: "recommended",
        target: String(fakePid),
      }),
    ]);
  }
  expect(kill).not.toHaveBeenCalled();
  expect(mocks.note.mock.calls.filter(([, title]) => title === "Doctor warnings")).toEqual([]);
});
