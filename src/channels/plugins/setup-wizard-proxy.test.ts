import {
  promptSetupWizardAllowFrom as promptFrom,
  resolveSetupWizardAllowFromEntries as resolveEntries,
  resolveSetupWizardGroupAllowlist as resolveAllowlist,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { assert, expect, it, vi } from "vitest";
import {
  createAllowlistSetupWizardProxy,
  createDelegatedSetupWizardProxy,
} from "./setup-wizard-proxy.js";
import type { ChannelSetupWizard } from "./setup-wizard.js";

const statusLabels = {
  configuredLabel: "configured",
  unconfiguredLabel: "needs setup",
  configuredHint: "ready",
  unconfiguredHint: "missing",
  configuredScore: 1,
  unconfiguredScore: 0,
};
const wizardBase: ChannelSetupWizard = {
  channel: "demo",
  status: { ...statusLabels, resolveConfigured: () => true },
  credentials: [],
};

it("falls back when delegated surfaces are absent", async () => {
  const createBase = vi.fn<Parameters<typeof createAllowlistSetupWizardProxy>[0]["createBase"]>(
    () => wizardBase,
  );
  createAllowlistSetupWizardProxy({
    loadWizard: async () => wizardBase,
    createBase,
    fallbackResolvedGroupAllowlist: (entries) => entries.map((input) => ({ input })),
  });

  const call = createBase.mock.calls[0];
  assert(call);
  const { promptAllowFrom, resolveAllowFromEntries, resolveGroupAllowlist } = call[0];
  expect(await promptFrom({ promptAllowFrom })).toStrictEqual({});
  expect(
    await resolveEntries({ resolveEntries: resolveAllowFromEntries, entries: ["alice"] }),
  ).toEqual([{ input: "alice", resolved: false, id: null }]);
  expect(
    await resolveAllowlist({ resolveAllowlist: resolveGroupAllowlist, entries: ["general"] }),
  ).toEqual([{ input: "general" }]);
});
it("builds a direct proxy wizard with delegated status/prepare/finalize", async () => {
  const wizard = createDelegatedSetupWizardProxy({
    channel: "demo",
    loadWizard: async (): Promise<ChannelSetupWizard> => ({
      ...wizardBase,
      status: {
        ...statusLabels,
        resolveConfigured: async ({ cfg }) => Boolean(cfg.channels?.demo),
        resolveStatusLines: async () => ["line"],
        resolveSelectionHint: async () => "hint",
        resolveQuickstartScore: async () => 3,
      },
      prepare: async ({ cfg }) => ({ cfg: { ...cfg, channels: { demo: { prepared: true } } } }),
      finalize: async ({ cfg }) => ({ cfg: { ...cfg, channels: { demo: { finalized: true } } } }),
    }),
    status: statusLabels,
    credentials: [],
    textInputs: [],
    completionNote: { title: "Done", lines: ["line"] },
    delegatePrepare: true,
    delegateFinalize: true,
  });

  expect(await wizard.status.resolveConfigured({ cfg: {} })).toBe(false);
  expect(await wizard.status.resolveStatusLines?.({ cfg: {}, configured: false })).toEqual([
    "line",
  ]);
  expect(await wizard.status.resolveSelectionHint?.({ cfg: {}, configured: false })).toBe("hint");
  expect(await wizard.status.resolveQuickstartScore?.({ cfg: {}, configured: false })).toBe(3);
  expect(await runSetupWizardPrepare({ prepare: wizard.prepare })).toEqual({
    cfg: { channels: { demo: { prepared: true } } },
  });
  expect(await runSetupWizardFinalize({ finalize: wizard.finalize })).toEqual({
    cfg: { channels: { demo: { finalized: true } } },
  });
});
