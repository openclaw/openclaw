import { describe, expect, it, vi } from "vitest";
import type { MullusiConfig } from "../../config/config.js";
import { configureChannelAccessWithAllowlist } from "./setup-group-access-configure.js";
import type { ChannelAccessPolicy } from "./setup-group-access.js";

function createPrompter(params: { confirm: boolean; policy?: ChannelAccessPolicy; text?: string }) {
  return {
    confirm: vi.fn(async () => params.confirm),
    select: vi.fn(async () => params.policy ?? "allowlist"),
    text: vi.fn(async () => params.text ?? ""),
    note: vi.fn(),
  };
}

async function runConfigureChannelAccess<TResolved>(params: {
  cfg: MullusiConfig;
  prompter: ReturnType<typeof createPrompter>;
  label?: string;
  placeholder?: string;
  setPolicy: (cfg: MullusiConfig, policy: ChannelAccessPolicy) => MullusiConfig;
  resolveAllowlist: (params: { cfg: MullusiConfig; entries: string[] }) => Promise<TResolved>;
  applyAllowlist: (params: { cfg: MullusiConfig; resolved: TResolved }) => MullusiConfig;
}) {
  return await configureChannelAccessWithAllowlist({
    cfg: params.cfg,
    // oxlint-disable-next-line typescript/no-explicit-any
    prompter: params.prompter as any,
    label: params.label ?? "Slack channels",
    currentPolicy: "allowlist",
    currentEntries: [],
    placeholder: params.placeholder ?? "#general",
    updatePrompt: true,
    setPolicy: params.setPolicy,
    resolveAllowlist: params.resolveAllowlist,
    applyAllowlist: params.applyAllowlist,
  });
}

describe("configureChannelAccessWithAllowlist", () => {
  it("returns input config when user skips access configuration", async () => {
    const cfg: MullusiConfig = {};
    const prompter = createPrompter({ confirm: false });
    const setPolicy = vi.fn((next: MullusiConfig) => next);
    const resolveAllowlist = vi.fn(async () => [] as string[]);
    const applyAllowlist = vi.fn((params: { cfg: MullusiConfig }) => params.cfg);

    const next = await runConfigureChannelAccess({
      cfg,
      prompter,
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next).toBe(cfg);
    expect(setPolicy).not.toHaveBeenCalled();
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("applies non-allowlist policy directly", async () => {
    const cfg: MullusiConfig = {};
    const prompter = createPrompter({
      confirm: true,
      policy: "open",
    });
    const setPolicy = vi.fn(
      (next: MullusiConfig, policy: ChannelAccessPolicy): MullusiConfig => ({
        ...next,
        channels: { discord: { groupPolicy: policy } },
      }),
    );
    const resolveAllowlist = vi.fn(async () => ["ignored"]);
    const applyAllowlist = vi.fn((params: { cfg: MullusiConfig }) => params.cfg);

    const next = await runConfigureChannelAccess({
      cfg,
      prompter,
      label: "Discord channels",
      placeholder: "guild/channel",
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next.channels?.discord?.groupPolicy).toBe("open");
    expect(setPolicy).toHaveBeenCalledWith(cfg, "open");
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("supports allowlist policies without prompting for entries", async () => {
    const cfg: MullusiConfig = {};
    const prompter = createPrompter({
      confirm: true,
      policy: "allowlist",
    });
    const setPolicy = vi.fn(
      (next: MullusiConfig, policy: ChannelAccessPolicy): MullusiConfig => ({
        ...next,
        channels: { twitch: { groupPolicy: policy } },
      }),
    );
    const resolveAllowlist = vi.fn(async () => ["ignored"]);
    const applyAllowlist = vi.fn((params: { cfg: MullusiConfig }) => params.cfg);

    const next = await configureChannelAccessWithAllowlist({
      cfg,
      // oxlint-disable-next-line typescript/no-explicit-any
      prompter: prompter as any,
      label: "Twitch chat",
      currentPolicy: "disabled",
      currentEntries: [],
      placeholder: "",
      updatePrompt: false,
      skipAllowlistEntries: true,
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(next.channels).toEqual({ twitch: { groupPolicy: "allowlist" } });
    expect(resolveAllowlist).not.toHaveBeenCalled();
    expect(applyAllowlist).not.toHaveBeenCalled();
  });

  it("resolves allowlist entries and applies them after forcing allowlist policy", async () => {
    const cfg: MullusiConfig = {};
    const prompter = createPrompter({
      confirm: true,
      policy: "allowlist",
      text: "#general, #support",
    });
    const calls: string[] = [];
    const setPolicy = vi.fn((next: MullusiConfig, policy: ChannelAccessPolicy): MullusiConfig => {
      calls.push("setPolicy");
      return {
        ...next,
        channels: { slack: { groupPolicy: policy } },
      };
    });
    const resolveAllowlist = vi.fn(async (params: { cfg: MullusiConfig; entries: string[] }) => {
      calls.push("resolve");
      expect(params.cfg).toBe(cfg);
      expect(params.entries).toEqual(["#general", "#support"]);
      return ["C1", "C2"];
    });
    const applyAllowlist = vi.fn((params: { cfg: MullusiConfig; resolved: string[] }) => {
      calls.push("apply");
      expect(params.cfg.channels?.slack?.groupPolicy).toBe("allowlist");
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          slack: {
            ...params.cfg.channels?.slack,
            channels: Object.fromEntries(params.resolved.map((id) => [id, { enabled: true }])),
          },
        },
      };
    });

    const next = await runConfigureChannelAccess({
      cfg,
      prompter,
      setPolicy,
      resolveAllowlist,
      applyAllowlist,
    });

    expect(calls).toEqual(["resolve", "setPolicy", "apply"]);
    expect(next.channels?.slack?.channels).toEqual({
      C1: { enabled: true },
      C2: { enabled: true },
    });
  });
});
