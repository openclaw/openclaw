import { describe, expect, it, vi } from "vitest";
import { createWizardPrompter } from "../../../test/helpers/wizard-prompter.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createChannelTestPluginBase } from "../../test-utils/channel-plugins.js";
import { runSetupWizardConfigure } from "../../test-utils/plugin-setup-wizard.js";
import type { ChannelAccessPolicy } from "./setup-group-access.js";
import type { ChannelSetupWizard } from "./setup-wizard-types.js";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "./setup-wizard.js";

type GroupAccess = NonNullable<ChannelSetupWizard["groupAccess"]>;

function createPrompter(params: { confirm: boolean; policy?: ChannelAccessPolicy; text?: string }) {
  return createWizardPrompter(
    {
      confirm: vi.fn(async () => params.confirm),
      text: vi.fn(async () => params.text ?? ""),
    },
    { defaultSelect: params.policy ?? "allowlist" },
  );
}

async function configure(
  cfg: OpenClawConfig,
  prompter: ReturnType<typeof createPrompter>,
  groupAccess: Pick<GroupAccess, "setPolicy"> & Partial<GroupAccess>,
  finalize?: ChannelSetupWizard["finalize"],
) {
  const adapter = buildChannelSetupWizardAdapterFromSetupWizard({
    plugin: createChannelTestPluginBase({ id: "demo" }),
    wizard: {
      channel: "demo",
      status: {
        configuredLabel: "Configured",
        unconfiguredLabel: "Not configured",
        resolveConfigured: () => false,
      },
      credentials: [],
      groupAccess: {
        label: "Slack channels",
        placeholder: "#general",
        currentPolicy: () => "allowlist",
        currentEntries: () => [],
        updatePrompt: () => true,
        ...groupAccess,
      },
      finalize,
    },
  });
  return (await runSetupWizardConfigure({ configure: adapter.configure, cfg, prompter })).cfg;
}

describe("channel setup wizard group access", () => {
  it("keeps the config and continues finalization when access configuration is skipped", async () => {
    const cfg: OpenClawConfig = {};
    const setPolicy = vi.fn<GroupAccess["setPolicy"]>(({ cfg: current }) => current);
    const resolveAllowlist = vi.fn(async () => []);
    const applyAllowlist = vi.fn<NonNullable<GroupAccess["applyAllowlist"]>>(
      ({ cfg: current }) => current,
    );
    const finalize = vi.fn();

    expect(
      await configure(
        cfg,
        createPrompter({ confirm: false }),
        { setPolicy, resolveAllowlist, applyAllowlist },
        finalize,
      ),
    ).toBe(cfg);
    expect(setPolicy).not.toHaveBeenCalled();
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
    expect(finalize).toHaveBeenCalledOnce();
  });

  it("applies non-allowlist policy without resolving or reapplying old entries", async () => {
    const resolveAllowlist = vi.fn(async () => ["ignored"]);
    const applyAllowlist = vi.fn<NonNullable<GroupAccess["applyAllowlist"]>>(({ cfg }) => cfg);
    const next = await configure({}, createPrompter({ confirm: true, policy: "open" }), {
      label: "Discord channels",
      placeholder: "guild/channel",
      setPolicy: ({ cfg, policy }) => ({
        ...cfg,
        channels: { discord: { groupPolicy: policy } },
      }),
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next.channels?.discord?.groupPolicy).toBe("open");
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("supports allowlist policies without prompting for entries", async () => {
    const resolveAllowlist = vi.fn(async () => ["ignored"]);
    const applyAllowlist = vi.fn<NonNullable<GroupAccess["applyAllowlist"]>>(({ cfg }) => cfg);
    const next = await configure({}, createPrompter({ confirm: true }), {
      label: "Twitch chat",
      placeholder: "",
      currentPolicy: () => "disabled",
      updatePrompt: () => false,
      skipAllowlistEntries: true,
      setPolicy: ({ cfg, policy }) => ({
        ...cfg,
        channels: { twitch: { groupPolicy: policy } },
      }),
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next.channels).toEqual({ twitch: { groupPolicy: "allowlist" } });
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("resolves entries before setting policy and applying the resolved allowlist", async () => {
    const cfg: OpenClawConfig = {};
    const calls: string[] = [];
    const resolved = ["C1", "C2"];
    const next = await configure(
      cfg,
      createPrompter({ confirm: true, text: "#general, #support" }),
      {
        resolveAllowlist: async ({ cfg: current, entries }) => {
          calls.push("resolve");
          expect(current).toBe(cfg);
          expect(entries).toEqual(["#general", "#support"]);
          return resolved;
        },
        setPolicy: ({ cfg: current, policy }) => {
          calls.push("setPolicy");
          return { ...current, channels: { slack: { groupPolicy: policy } } };
        },
        applyAllowlist: ({ cfg: current, resolved: actual }) => {
          calls.push("apply");
          expect(actual).toBe(resolved);
          expect(current.channels?.slack?.groupPolicy).toBe("allowlist");
          return {
            ...current,
            channels: {
              ...current.channels,
              slack: {
                ...current.channels?.slack,
                channels: Object.fromEntries(resolved.map((id) => [id, { enabled: true }])),
              },
            },
          };
        },
      },
    );

    expect(calls).toEqual(["resolve", "setPolicy", "apply"]);
    expect(next.channels?.slack?.channels).toEqual({
      C1: { enabled: true },
      C2: { enabled: true },
    });
  });
});
