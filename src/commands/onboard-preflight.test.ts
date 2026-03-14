import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";

const readConfigFileSnapshot = vi.hoisted(() =>
  vi.fn(async () => ({
    path: "/mock/.openclaw/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    resolved: {} as OpenClawConfig,
    valid: true,
    config: {} as OpenClawConfig,
    issues: [],
  })),
);

const probeGatewayReachable = vi.hoisted(() => vi.fn(async () => ({ ok: true })));

const resolveControlUiLinks = vi.hoisted(() =>
  vi.fn(() => ({ wsUrl: "ws://localhost:18789", httpUrl: "http://localhost:18789" })),
);

const buildAuthHealthSummary = vi.hoisted(() =>
  vi.fn(
    () =>
      ({
        now: Date.now(),
        warnAfterMs: 86400000,
        profiles: [],
        providers: [],
      }) as {
        now: number;
        warnAfterMs: number;
        profiles: unknown[];
        providers: { provider: string; status: string; profiles: unknown[] }[];
      },
  ),
);

const loadAuthProfileStore = vi.hoisted(() => vi.fn(() => ({})));

const loadModelCatalog = vi.hoisted(() => vi.fn(async () => []));

const resolveConfiguredModelRef = vi.hoisted(() =>
  vi.fn(() => ({ provider: "anthropic", model: "claude-sonnet-4-5-20250514" })),
);

const getModelRefStatus = vi.hoisted(() =>
  vi.fn(() => ({
    key: "anthropic/claude-sonnet-4-5-20250514",
    inCatalog: true,
    allowAny: false,
    allowed: true,
  })),
);

const formatCliCommand = vi.hoisted(() => vi.fn((cmd: string) => cmd));

const fsAccess = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("node:fs/promises", () => ({ access: fsAccess, constants: { W_OK: 2 } }));
vi.mock("../config/io.js", () => ({ readConfigFileSnapshot }));
vi.mock("./onboard-helpers.js", () => ({ probeGatewayReachable, resolveControlUiLinks }));
vi.mock("../agents/auth-health.js", () => ({ buildAuthHealthSummary }));
vi.mock("../agents/auth-profiles/store.js", () => ({ loadAuthProfileStore }));
vi.mock("../agents/model-catalog.js", () => ({ loadModelCatalog }));
vi.mock("../agents/model-selection.js", () => ({ resolveConfiguredModelRef, getModelRefStatus }));
vi.mock("../agents/defaults.js", () => ({
  DEFAULT_MODEL: "claude-sonnet-4-5-20250514",
  DEFAULT_PROVIDER: "anthropic",
}));
vi.mock("../cli/command-format.js", () => ({ formatCliCommand }));
vi.mock("../utils.js", () => ({ resolveUserPath: (p: string) => p.replace("~", "/mock") }));

import { runPostOnboardPreflight } from "./onboard-preflight.js";

function createRuntime(): RuntimeEnv {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() } as unknown as RuntimeEnv;
}

describe("runPostOnboardPreflight", () => {
  let runtime: RuntimeEnv;

  beforeEach(() => {
    runtime = createRuntime();
    vi.clearAllMocks();

    // Reset to passing defaults
    readConfigFileSnapshot.mockResolvedValue({
      path: "/mock/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {} as OpenClawConfig,
      valid: true,
      config: {} as OpenClawConfig,
      issues: [],
    });
    probeGatewayReachable.mockResolvedValue({ ok: true });
    buildAuthHealthSummary.mockReturnValue({
      now: Date.now(),
      warnAfterMs: 86400000,
      profiles: [],
      providers: [{ provider: "anthropic", status: "ok", profiles: [] }],
    });
    getModelRefStatus.mockReturnValue({
      key: "anthropic/claude-sonnet-4-5-20250514",
      inCatalog: true,
      allowAny: false,
      allowed: true,
    });
  });

  it("prints all-pass when every check succeeds", async () => {
    await runPostOnboardPreflight({} as OpenClawConfig, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain("[PASS] Config");
    expect(output).toContain("[PASS] Gateway");
    expect(output).toContain("[PASS] Auth");
    expect(output).toContain("[PASS] Workspace");
    expect(output).toContain("[PASS] Model");
    expect(output).not.toContain("issue");
  });

  it("shows WARN and doctor hint for failed config", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      path: "/mock/.openclaw/openclaw.json",
      exists: true,
      raw: "{}",
      parsed: {},
      resolved: {} as OpenClawConfig,
      valid: false,
      config: {} as OpenClawConfig,
      issues: [{ message: "unknown key: hooks" } as never],
    });

    await runPostOnboardPreflight({} as OpenClawConfig, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain("[FAIL] Config");
    expect(output).toContain("unknown key: hooks");
    expect(output).toContain("openclaw doctor");
  });

  it("shows WARN for unreachable gateway", async () => {
    probeGatewayReachable.mockResolvedValue({ ok: false, detail: "connection refused" } as never);

    await runPostOnboardPreflight({} as OpenClawConfig, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain("[WARN] Gateway");
    expect(output).toContain("connection refused");
  });

  it("shows WARN for expired auth", async () => {
    buildAuthHealthSummary.mockReturnValue({
      now: Date.now(),
      warnAfterMs: 86400000,
      profiles: [],
      providers: [{ provider: "anthropic", status: "expired", profiles: [] }],
    });

    await runPostOnboardPreflight({} as OpenClawConfig, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain("[WARN] Auth");
    expect(output).toContain("token expired");
  });

  it("skips gateway and workspace checks in remote mode", async () => {
    await runPostOnboardPreflight({} as OpenClawConfig, runtime, { isRemote: true });

    expect(probeGatewayReachable).not.toHaveBeenCalled();
    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).not.toContain("Gateway");
    expect(output).not.toContain("Workspace");
    expect(output).toContain("[PASS] Config");
    expect(output).toContain("[PASS] Model");
  });

  it("shows WARN for model not in catalog", async () => {
    getModelRefStatus.mockReturnValue({
      key: "anthropic/nonexistent-model",
      inCatalog: false,
      allowAny: false,
      allowed: false,
    });

    await runPostOnboardPreflight({} as OpenClawConfig, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain("[WARN] Model");
    expect(output).toContain("not in catalog");
  });

  it("treats empty auth store as passing", async () => {
    loadAuthProfileStore.mockImplementation(() => {
      throw new Error("no store");
    });

    await runPostOnboardPreflight({} as OpenClawConfig, runtime);

    const output = (runtime.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(output).toContain("[PASS] Auth");
    expect(output).toContain("no auth profiles configured");
  });
});
