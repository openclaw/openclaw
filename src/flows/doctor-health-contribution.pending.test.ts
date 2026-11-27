import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { traceDoctorMaintenancePending } from "../commands/doctor-maintenance-pending.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";
import {
  createDoctorHealthFlowContext,
  createDoctorPrompterFixture,
  decideDoctorContributionPending,
} from "./doctor-health-context.test-support.js";
import { createDoctorHealthContribution, legacyOwnedRepair } from "./doctor-health-contribution.js";
import { resolveDoctorHealthContributions } from "./doctor-health-contributions.test-support.js";
import type { HealthFinding } from "./health-checks.js";

// The OS boundary: systemd queries and the interactive loginctl repair.
const systemd = vi.hoisted(() => ({
  linger: vi.fn<() => Promise<{ user: string; linger: "yes" | "no" } | null>>(),
  ensureLinger: vi.fn(async () => {}),
}));
vi.mock("../commands/doctor-service-repair-policy.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/doctor-service-repair-policy.js")>()),
  shouldManageGatewayService: async () => true,
}));
vi.mock("../daemon/systemd.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/systemd.js")>()),
  findInstalledSystemdGatewayScope: async () => ({ scope: "user" }),
  isSystemdUserServiceAvailable: async () => true,
  resolveSystemdUserServiceAccount: () => "alice",
  readSystemdUserLingerStatus: systemd.linger,
}));
vi.mock("../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../daemon/service.js")>()),
  resolveGatewayService: () => ({}),
  readGatewayServiceState: async () => ({ loadState: { status: "loaded" } }),
}));
vi.mock("../commands/systemd-linger.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/systemd-linger.js")>()),
  ensureSystemdUserLingerInteractive: systemd.ensureLinger,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  systemd.linger.mockReset();
  systemd.ensureLinger.mockClear();
});

const context = (overrides: Parameters<typeof createDoctorHealthFlowContext>[0] = {}) =>
  createDoctorHealthFlowContext({
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    prompter: createDoctorPrompterFixture(true),
    options: { repair: true, nonInteractive: true },
    gatewayMaintenanceActive: true,
    ...overrides,
  });

function contribution(id: string) {
  const found = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!found) {
    throw new Error(`Missing Doctor contribution: ${id}`);
  }
  return found;
}

describe("health-check contributions derive pending work from their repairs", () => {
  const finding = (checkId: string): HealthFinding => ({
    checkId,
    severity: "warning",
    message: "repair me",
  });

  it("has work while a repairable check has a finding, and the run repairs it", async () => {
    const marker = path.join(tempDirs.make("doctor-derived-pending-"), "repaired");
    const derived = createDoctorHealthContribution("doctor:derived", "Derived", {
      healthChecks: {
        description: "Writes the marker once.",
        async detect() {
          return fs.existsSync(marker) ? [] : [finding("core/doctor/derived")];
        },
        async repair() {
          fs.writeFileSync(marker, "repaired");
          return { changes: ["Wrote the marker."] };
        },
      },
    });

    await expect(decideDoctorContributionPending(derived, context())).resolves.toBe("work");
    expect(fs.existsSync(marker)).toBe(false);
    // Plain Doctor runs repairs as a dry run, which writes nothing.
    const plain = context({ prompter: createDoctorPrompterFixture(false) });
    await expect(decideDoctorContributionPending(derived, plain)).resolves.toBe("none");

    await derived.run(context());
    expect(fs.readFileSync(marker, "utf8")).toBe("repaired");
    await expect(decideDoctorContributionPending(derived, context())).resolves.toBe("none");
  });

  it("has no work from findings it cannot repair or only describes", async () => {
    const detectOnly = createDoctorHealthContribution("doctor:detect-only", "Detect only", {
      healthChecks: { description: "Reports.", detect: async () => [finding("core/x")] },
    });
    const described = createDoctorHealthContribution("doctor:described", "Described", {
      healthChecks: {
        description: "Another owner repairs this.",
        detect: async () => [finding("core/doctor/described")],
        repair: legacyOwnedRepair(async () => [], "the owner's run repairs this"),
      },
    });

    await expect(decideDoctorContributionPending(detectOnly, context())).resolves.toBe("none");
    await expect(decideDoctorContributionPending(described, context())).resolves.toBe("none");
  });

  it("counts a failing detect as undecidable work", async () => {
    vi.stubEnv("OPENCLAW_GATEWAY_STARTUP_TRACE", "1");
    const lines: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    });
    const failing = createDoctorHealthContribution("doctor:failing", "Failing", {
      healthChecks: {
        description: "Cannot inspect.",
        detect: async () => {
          throw new Error("store unreadable");
        },
        repair: async () => ({ changes: [] }),
      },
    });

    await expect(
      traceDoctorMaintenancePending("contribution.doctor:failing", () =>
        decideDoctorContributionPending(failing, context()),
      ),
    ).resolves.toBe(true);
    expect(lines.filter((line) => line.includes("doctor.pending."))).toEqual([
      expect.stringMatching(/pending=undecidable check=owner /u),
    ]);
  });
});

describe("contributions that Doctor defers while it holds Gateway maintenance", () => {
  it.each(["doctor:retained-update-runtimes", "doctor:gateway-daemon", "doctor:gateway-services"])(
    "%s has work only outside maintenance",
    async (id) => {
      mockProcessPlatform("linux");
      // The account's own home: the default install, which owns its service.
      const env = { HOME: os.userInfo().homedir };
      await expect(
        decideDoctorContributionPending(contribution(id), context({ env })),
      ).resolves.toBe("none");
      await expect(
        decideDoctorContributionPending(
          contribution(id),
          context({ env, gatewayMaintenanceActive: false }),
        ),
      ).resolves.toBe("work");
    },
  );

  it("removes no retained runtime under maintenance, where the cleanup ran before the stop", async () => {
    const retained = contribution("doctor:retained-update-runtimes");
    const cleanup = await import("../commands/doctor-retained-runtime.js");
    const prepare = vi.spyOn(cleanup, "prepareRetainedUpdateRuntimeCleanup");

    await retained.run(context());
    expect(prepare).not.toHaveBeenCalled();
    await expect(
      decideDoctorContributionPending(
        retained,
        context({ prompter: createDoctorPrompterFixture(false), gatewayMaintenanceActive: false }),
      ),
    ).resolves.toBe("none");
  });
});

describe("systemd linger contribution", () => {
  it("has work only when an interactive run would enable disabled lingering", async () => {
    mockProcessPlatform("linux");
    const linger = contribution("doctor:systemd-linger");
    const interactive = context({
      cfg: { gateway: { mode: "local" } },
      options: { repair: true },
      prompter: createDoctorPrompterFixture(true, true),
    });
    systemd.linger.mockResolvedValue({ user: "alice", linger: "no" });

    await expect(decideDoctorContributionPending(linger, interactive)).resolves.toBe("work");
    await expect(
      decideDoctorContributionPending(linger, context({ cfg: { gateway: { mode: "local" } } })),
    ).resolves.toBe("none");
    expect(systemd.ensureLinger).not.toHaveBeenCalled();
    await linger.run(interactive);
    expect(systemd.ensureLinger).toHaveBeenCalledOnce();

    systemd.linger.mockResolvedValue({ user: "alice", linger: "yes" });
    await expect(decideDoctorContributionPending(linger, interactive)).resolves.toBe("none");
  });
});
