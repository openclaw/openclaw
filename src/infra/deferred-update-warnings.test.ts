import { expect, it, vi } from "vitest";
import { retainCurrentDeferredUpdateWarnings } from "./deferred-update-warnings.js";
import { DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING } from "./update-deferred-model-retirement.js";
import { readRetiredPluginVersionDriftWarnings } from "./update-plugin-version-warnings.js";

const versionDrift =
  "core/doctor/workspace-status: Plugin codex is 2026.10.10, but a Gateway restart will load OpenClaw 2026.11.10.";
type PluginUpdate = NonNullable<Parameters<typeof readRetiredPluginVersionDriftWarnings>[1]>;
const updated = {
  pluginId: "codex",
  status: "updated",
  currentVersion: "2026.10.10",
  nextVersion: "2026.11.10",
  message: "Updated codex.",
} as const;
function pluginOutcome(overrides: Partial<PluginUpdate> = {}): PluginUpdate {
  return {
    status: "ok",
    changed: true,
    sync: { changed: false, switchedToBundled: [], switchedToNpm: [], warnings: [], errors: [] },
    npm: { changed: true, outcomes: [updated] },
    integrityDrifts: [],
    ...overrides,
  };
}

it("settles individual version findings only with the selected final version", async () => {
  const pinned = `${versionDrift} The confirmed plugin target is 2026.11.10. The running Gateway is 2026.10.10.`;
  const unrelated = "Unrelated advisory";
  const mixed = `${versionDrift}\n${unrelated}`;
  const warnings = [versionDrift, pinned, unrelated, mixed];
  const plugins = pluginOutcome({
    npm: {
      changed: false,
      outcomes: [{ ...updated, status: "unchanged", currentVersion: "2026.11.10" }],
    },
  });

  expect(await retainCurrentDeferredUpdateWarnings(warnings, { pluginUpdate: plugins })).toEqual([
    unrelated,
    mixed,
  ]);
});

it.each([
  pluginOutcome({ status: "error" }),
  pluginOutcome({
    status: "warning",
    warnings: [
      { reason: "plugin-config-conflict", message: "Plugin changes rolled back.", guidance: [] },
    ],
  }),
  pluginOutcome({
    npm: {
      changed: true,
      outcomes: [updated, { ...updated, status: "error", message: "Convergence failed." }],
    },
  }),
])("retains version findings without a kept successful outcome", (plugins) => {
  expect(readRetiredPluginVersionDriftWarnings([versionDrift], plugins)).toEqual(new Set());
});

it.each(["completed", "skipped", "failed", undefined] as const)(
  "requires positive retirement completion (%s)",
  async (status) => {
    const warnings = [DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING, "Unrelated advisory"];
    const readUpdateRun = vi.fn(() => ({
      steps: status ? [{ step: "finalize:doctor:model-retirement", status }] : [],
    }));

    expect(await retainCurrentDeferredUpdateWarnings(warnings, { readUpdateRun })).toEqual(
      status === "completed" ? warnings.slice(1) : warnings,
    );
    expect(readUpdateRun).toHaveBeenCalledOnce();
  },
);

it("reads the selected run only when needed and preserves warnings on read failure", async () => {
  const readUpdateRun = vi.fn(() => {
    throw new Error("Selected update ledger unavailable");
  });
  const unrelated = ["Unrelated advisory"];
  expect(await retainCurrentDeferredUpdateWarnings(unrelated, { readUpdateRun })).toEqual(
    unrelated,
  );
  expect(readUpdateRun).not.toHaveBeenCalled();

  const warnings = [DEFERRED_UPDATE_MODEL_RETIREMENT_WARNING, ...unrelated];
  expect(await retainCurrentDeferredUpdateWarnings(warnings, { readUpdateRun })).toEqual(warnings);
  expect(readUpdateRun).toHaveBeenCalledOnce();
  expect(await retainCurrentDeferredUpdateWarnings(warnings)).toEqual(warnings);
});
