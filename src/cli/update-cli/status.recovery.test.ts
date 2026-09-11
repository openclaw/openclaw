import { beforeEach, expect, it, vi } from "vitest";
import { updateStatusCommand } from "./status.js";

const mocks = vi.hoisted(() => ({
  inspect:
    vi.fn<typeof import("../../infra/update-recovery-backup.js").inspectUpdateRecoveryBackups>(),
  log: vi.fn(),
  writeJson: vi.fn(),
}));

vi.mock("../../infra/update-recovery-backup.js", () => ({
  inspectUpdateRecoveryBackups: mocks.inspect,
}));
vi.mock("../../commands/node-runtime-diagnostics.js", () => ({
  collectNodeRuntimeFindings: async () => [],
}));
vi.mock("../../config/config.js", () => ({ readSourceConfigBestEffort: async () => ({}) }));
vi.mock("../../infra/update-run-status.js", () => ({ readUpdateRunStatus: () => ({}) }));
vi.mock("../../runtime.js", () => ({ defaultRuntime: mocks }));
vi.mock("../../infra/update-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../infra/update-check.js")>()),
  checkUpdateStatus: async () => ({
    root: "/fixture/new-cli",
    installKind: "package",
    packageManager: "npm",
    registry: { latestVersion: "2026.9.3" },
  }),
}));
vi.mock("./shared.js", () => ({
  resolveUpdateRoot: async () => "/fixture/new-cli",
  parseTimeoutMsOrExit: () => undefined,
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.inspect.mockResolvedValue([]);
});

it.each([true, false])("reports every retained recovery set (JSON: %s)", async (json) => {
  const sets = (["unresolved", "ambiguous", "stale", "unresolved"] as const).map(
    (status, index) => ({
      ref: {
        directory: `/fixture/state/updates/set-${index}/backup`,
        manifestPath: `/fixture/state/updates/set-${index}/backup/manifest.json`,
        manifestSha256: "a".repeat(64),
      },
      runId: `recovery-${index}`,
      captureStatus: "pending" as const,
      status,
      terminalOutcome: status === "stale" ? ("committed" as const) : undefined,
      message: `Retained set ${index} is ${status}.`,
      nextAction:
        status === "unresolved"
          ? "npx openclaw@latest doctor --fix"
          : "openclaw update status --json",
    }),
  );
  mocks.inspect.mockResolvedValue(sets);

  await updateStatusCommand({ json });

  if (json) {
    expect(mocks.writeJson.mock.lastCall?.[0].recoverySets).toEqual(
      sets.map(({ ref, runId, status, message, nextAction }) => ({
        runId,
        manifestPath: ref.manifestPath,
        status,
        message,
        nextAction,
      })),
    );
  } else {
    const output = mocks.log.mock.calls.flat().join("\n");
    for (const set of sets) {
      expect(output).toContain(set.runId);
      expect(output).toContain(set.ref.manifestPath);
      expect(output).toContain(set.status);
      expect(output).toContain(set.message);
      expect(output).toContain(set.nextAction);
    }
  }
  // A newer/npx CLI must still expose sets belonging to an older installation root.
  expect(mocks.inspect.mock.calls[0]?.[0]?.installRoot).toBeUndefined();
});

it("reports an empty recovery inventory explicitly in JSON", async () => {
  await updateStatusCommand({ json: true });
  expect(mocks.writeJson.mock.lastCall?.[0].recoverySets).toEqual([]);
  expect(mocks.writeJson.mock.lastCall?.[0]).not.toHaveProperty("recoverySetsError");
});

it.each([true, false])(
  "reports recovery inspection failure distinctly (JSON: %s)",
  async (json) => {
    mocks.inspect.mockRejectedValue(new Error("Recovery manifest unreadable"));

    await expect(updateStatusCommand({ json })).resolves.toBeUndefined();

    if (json) {
      const result = mocks.writeJson.mock.lastCall?.[0];
      expect(result).toHaveProperty("availability");
      expect(result.recoverySetsError).toBe("Recovery manifest unreadable");
      expect(result).not.toHaveProperty("recoverySets");
      expect(result).not.toHaveProperty("runStatusError");
    } else {
      const output = mocks.log.mock.calls.flat().join("\n");
      expect(output).toContain("OpenClaw update status");
      expect(output).toContain("Update recovery sets unavailable: Recovery manifest unreadable");
    }
  },
);
