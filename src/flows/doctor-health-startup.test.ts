import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createNonExitingRuntime } from "../runtime.js";
import { prepareDoctorHealthFlow } from "./doctor-health-startup.js";

const mocks = vi.hoisted(() => ({
  config: vi.fn<() => Promise<OpenClawConfig>>(),
  command: vi.fn(),
  note: vi.fn(),
}));
// mock-isolation: keep the startup directory probe away from operator paths and Nix policy.
vi.mock("../config/paths.js", () => ({
  resolveIsNixMode: () => false,
  resolveStateDir: () => "/synthetic/openclaw-state",
}));
// mock-isolation: read synthetic config without initializing the state-backed config runtime.
vi.mock("../config/io.runtime.js", () => ({ readSourceConfigBestEffort: mocks.config }));
// mock-isolation: inspect synthetic CLI status without invoking the operator Tailscale executable.
vi.mock("../process/exec.js", () => ({ runUtf8CommandWithTimeout: mocks.command }));
// mock-isolation: capture prerequisite output without rendering to the operator terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: mocks.note }));
// mock-isolation: avoid discovering installation ownership from the operator checkout.
vi.mock("../infra/openclaw-root.js", () => ({
  resolveOpenClawPackageRoot: vi.fn(async () => "/synthetic/openclaw"),
}));

beforeEach(() => {
  vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "");
  mocks.config.mockReset().mockResolvedValue({ gateway: { tailscale: { mode: "serve" } } });
  mocks.command.mockReset();
  mocks.note.mockReset();
});

afterEach(() => vi.unstubAllEnvs());

async function startDoctor() {
  return await prepareDoctorHealthFlow(createNonExitingRuntime(), {}, vi.fn());
}

describe("Doctor startup dependencies", () => {
  it("continues published-updater Doctor without invoking unsupported config reads", async () => {
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    mocks.config.mockRejectedValue(
      new Error(
        "Run config operation readSourceConfigBestEffort in the updated CLI after this update finishes.",
      ),
    );
    await expect(
      prepareDoctorHealthFlow(
        createNonExitingRuntime(),
        { repair: true, nonInteractive: true },
        vi.fn(),
      ),
    ).resolves.toMatchObject({ root: "/synthetic/openclaw" });
    expect(mocks.config).not.toHaveBeenCalled();
    expect(mocks.command).not.toHaveBeenCalled();
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it.each([
    ["Stopped", "Tailscale is stopped", "tailscale up"],
    ["NeedsLogin", "Tailscale is logged out", "tailscale login"],
    ["NeedsMachineAuth", "administrator approval", "admin console"],
    ["Starting", "still starting", "report Running"],
    ["NoState", "still starting", "report Running"],
    ["UnknownFutureState", "did not report a running backend", "Inspect"],
  ])("reports %s before admitting Doctor maintenance", async (state, reason, action) => {
    mocks.command.mockResolvedValue({
      code: state === "NeedsLogin" ? 1 : 0,
      stdout: JSON.stringify({ BackendState: state }),
    });
    await startDoctor();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(reason),
      "Gateway startup prerequisite",
    );
    expect(mocks.note.mock.calls[0]?.[0]).toContain(action);
    // Prerequisite inspection cannot enable connectivity or alter routes.
    expect(mocks.command.mock.calls.map(([argv]) => argv)).toEqual([
      ["tailscale", "status", "--json"],
    ]);
  });

  it("checks Funnel and preserveFunnel without changing operator config", async () => {
    for (const tailscale of [
      { mode: "funnel" as const },
      { mode: "serve" as const, preserveFunnel: true },
    ]) {
      mocks.note.mockClear();
      const cfg: OpenClawConfig = { gateway: { tailscale } };
      const original = structuredClone(cfg);
      mocks.config.mockResolvedValue(cfg);
      mocks.command.mockResolvedValue({ code: 0, stdout: '{"BackendState":"Stopped"}' });
      await startDoctor();
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining(`gateway.tailscale.mode="${tailscale.mode}"`),
        "Gateway startup prerequisite",
      );
      expect(cfg).toEqual(original);
    }
  });

  it.each([
    {},
    { gateway: { tailscale: { mode: "off" as const } } },
    { gateway: { mode: "remote" as const, tailscale: { mode: "serve" as const } } },
  ])(
    "does not inspect a local backend when it is not a configured dependency (%j)",
    async (cfg) => {
      mocks.config.mockResolvedValue(cfg);
      await startDoctor();
      expect(mocks.command).not.toHaveBeenCalled();
      expect(mocks.note).not.toHaveBeenCalled();
    },
  );

  it("uses the macOS app fallback and stays quiet for a running backend", async () => {
    mocks.command
      .mockRejectedValueOnce(new Error("missing executable"))
      .mockResolvedValueOnce({ code: 0, stdout: 'notice\n{"BackendState":"Running"}\n' });
    await startDoctor();
    expect(mocks.note).not.toHaveBeenCalled();
    expect(mocks.command.mock.calls.map(([argv]) => argv)).toEqual([
      ["tailscale", "status", "--json"],
      ["/Applications/Tailscale.app/Contents/MacOS/Tailscale", "status", "--json"],
    ]);
  });

  it.each([
    [{ code: 1, stdout: "" }, "is unavailable"],
    [{ code: 0, stdout: "not-json" }, "could not be parsed"],
    [{ code: 0, stdout: '{"Self":{}}' }, "could not be parsed"],
  ])("reports inconclusive status instead of assuming readiness (%j)", async (response, reason) => {
    mocks.command.mockResolvedValue(response);
    await startDoctor();
    expect(mocks.note).toHaveBeenCalledWith(
      expect.stringContaining(reason),
      "Gateway startup prerequisite",
    );
    expect(mocks.note.mock.calls[0]?.[0]).toContain("Verify that the Tailscale CLI is installed");
  });
});
