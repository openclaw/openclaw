import {
  promptSetupWizardAllowFrom as promptFrom,
  resolveSetupWizardAllowFromEntries as resolveEntries,
  resolveSetupWizardGroupAllowlist as resolveAllowlist,
  runSetupWizardFinalize,
  runSetupWizardPrepare,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { expect, it } from "vitest";
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
  const wizard = createAllowlistSetupWizardProxy({
    loadWizard: async () => wizardBase,
    createBase: ({ promptAllowFrom, resolveAllowFromEntries, resolveGroupAllowlist }) => ({
      ...wizardBase,
      dmPolicy: {
        label: "Demo",
        channel: "demo" as never,
        policyKey: "channels.demo.dmPolicy",
        allowFromKey: "channels.demo.allowFrom",
        getCurrent: () => "pairing",
        setPolicy: (cfg) => cfg,
        promptAllowFrom,
      },
      allowFrom: {
        message: "Allow from",
        placeholder: "id",
        invalidWithoutCredentialNote: "need id",
        parseId: () => null,
        resolveEntries: resolveAllowFromEntries,
        apply: (params) => params.cfg,
      },
      groupAccess: {
        label: "Groups",
        placeholder: "group",
        currentPolicy: () => "allowlist",
        currentEntries: () => [],
        updatePrompt: () => false,
        setPolicy: (params) => params.cfg,
        resolveAllowlist: resolveGroupAllowlist,
      },
    }),
    fallbackResolvedGroupAllowlist: (entries) => entries.map((input) => ({ input })),
  });

  const { dmPolicy, allowFrom, groupAccess } = wizard;
  expect(await promptFrom({ promptAllowFrom: dmPolicy?.promptAllowFrom })).toStrictEqual({});
  expect(
    await resolveEntries({ resolveEntries: allowFrom?.resolveEntries, entries: ["alice"] }),
  ).toEqual([{ input: "alice", resolved: false, id: null }]);
  const groups = await resolveAllowlist({
    resolveAllowlist: groupAccess?.resolveAllowlist,
    entries: ["general"],
  });
  expect(groups).toEqual([{ input: "general" }]);
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
  const lines = await wizard.status.resolveStatusLines?.({ cfg: {}, configured: false });
  expect(lines).toEqual(["line"]);
  expect(await wizard.status.resolveSelectionHint?.({ cfg: {}, configured: false })).toBe("hint");
  expect(await wizard.status.resolveQuickstartScore?.({ cfg: {}, configured: false })).toBe(3);
  expect(await runSetupWizardPrepare({ prepare: wizard.prepare })).toEqual({
    cfg: { channels: { demo: { prepared: true } } },
  });
  expect(await runSetupWizardFinalize({ finalize: wizard.finalize })).toEqual({
    cfg: { channels: { demo: { finalized: true } } },
  });
});
