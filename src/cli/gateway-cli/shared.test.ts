import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../runtime.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeExplainGatewayServiceStop } from "./shared.js";

const isLoaded = vi.hoisted(() => vi.fn());
// mock-isolation: Exercise public stop guidance without querying the host service manager.
vi.mock("../../daemon/service.js", () => ({
  resolveGatewayService: () => ({ isLoaded, loadedText: "loaded" }),
}));

beforeEach(() => {
  isLoaded.mockReset().mockResolvedValue(true);
  vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
  vi.stubEnv("OPENCLAW_PROFILE", "work");
  vi.stubEnv("OPENCLAW_CONTAINER_HINT", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("does not warn when the managed service is unloaded", async () => {
  isLoaded.mockResolvedValue(false);
  await maybeExplainGatewayServiceStop();
  expect(defaultRuntime.error).not.toHaveBeenCalled();
});

it.each<{ platform: NodeJS.Platform; command: string }>([
  { platform: "darwin", command: "Or: launchctl bootout gui/$UID/ai.openclaw.work" },
  { platform: "linux", command: "Or: systemctl --user stop openclaw-gateway-work.service" },
  { platform: "win32", command: 'Or: schtasks /End /TN "OpenClaw Gateway (work)"' },
])("prints profile-aware $platform stop guidance", async ({ platform, command }) => {
  mockProcessPlatform(platform);
  await maybeExplainGatewayServiceStop();
  expect(vi.mocked(defaultRuntime.error).mock.calls.map(([line]) => line)).toEqual([
    "Gateway service appears loaded. Stop it first.",
    "Tip: openclaw --profile work gateway stop",
    command,
  ]);
});

it("keeps generic guidance when service status is unknown on another platform", async () => {
  mockProcessPlatform("freebsd");
  isLoaded.mockRejectedValue(new Error("service status unavailable"));
  await maybeExplainGatewayServiceStop();
  expect(vi.mocked(defaultRuntime.error).mock.calls.map(([line]) => line)).toEqual([
    "Gateway service status unknown; if supervised, stop it first.",
    "Tip: openclaw --profile work gateway stop",
  ]);
});
