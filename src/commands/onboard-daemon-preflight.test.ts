import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import * as systemd from "../daemon/systemd.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as helpers from "./onboard-helpers.js";
import * as nonInteractive from "./onboard-non-interactive.js";
import { setupWizardCommand } from "./onboard.js";
import { createTestRuntime } from "./test-runtime-config-helpers.js";

const options = { nonInteractive: true, acceptRisk: true, authChoice: "skip" } as const;
const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
function platform(value: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { ...originalPlatform, value });
}
afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.restoreAllMocks();
});

it.each([false, true])(
  "leaves profile untouched when systemd is missing (reset=%s)",
  async (reset) => {
    await withOpenClawTestState({}, async (state) => {
      const workspace = path.join(state.workspaceDir, "requested");
      const marker = path.join(workspace, "existing.txt");
      if (reset) {
        await fs.mkdir(workspace);
        await fs.writeFile(marker, "keep me");
        await state.writeConfig({
          agents: { defaults: { workspace } },
          plugins: { enabled: false },
        });
      }
      const before = reset ? await fs.readFile(state.configPath, "utf8") : undefined;
      platform("linux");
      const probe = vi.spyOn(systemd, "isSystemdUserServiceAvailable").mockResolvedValue(false);
      const cleanup = vi.spyOn(helpers, "handleReset").mockResolvedValue(undefined);
      const setup = vi.spyOn(nonInteractive, "runNonInteractiveSetup").mockResolvedValue(undefined);
      const runtime = createTestRuntime();
      await setupWizardCommand(
        {
          ...options,
          workspace,
          installDaemon: true,
          skipHealth: true,
          json: true,
          ...(reset ? { reset: true, resetScope: "full" } : {}),
        },
        runtime,
      );
      expect(probe).toHaveBeenCalledOnce();
      expect(cleanup).not.toHaveBeenCalled();
      expect(setup).not.toHaveBeenCalled();
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(runtime.log).toHaveBeenCalledTimes(1);
      expect(JSON.parse(String(runtime.log.mock.calls[0]?.[0]))).toMatchObject({
        ok: false,
        phase: "options",
        message: expect.stringContaining("--skip-daemon"),
      });
      if (reset) {
        expect(await fs.readFile(state.configPath, "utf8")).toBe(before);
        expect(await fs.readFile(marker, "utf8")).toBe("keep me");
      } else {
        await expect(fs.stat(state.configPath)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(fs.stat(workspace)).rejects.toMatchObject({ code: "ENOENT" });
      }
    });
  },
);

it.each([
  { os: "linux", flags: { installDaemon: true, mode: "local" }, calls: 1 },
  { os: "linux", flags: { installDaemon: false }, calls: 0 },
  { os: "linux", flags: {}, calls: 0 },
  { os: "linux", flags: { mode: "remote", remoteUrl: "ws://127.0.0.1:18789" }, calls: 0 },
  { os: "darwin", flags: { installDaemon: true }, calls: 0 },
] as const)("dispatches setup on $os with $flags", async ({ os, flags, calls }) => {
  await withOpenClawTestState({}, async () => {
    platform(os);
    const probe = vi.spyOn(systemd, "isSystemdUserServiceAvailable").mockResolvedValue(true);
    const setup = vi.spyOn(nonInteractive, "runNonInteractiveSetup").mockResolvedValue(undefined);
    const runtime = createTestRuntime();
    await setupWizardCommand({ ...options, ...flags }, runtime);
    expect(probe).toHaveBeenCalledTimes(calls);
    expect(setup).toHaveBeenCalledOnce();
    expect(runtime.exit).not.toHaveBeenCalled();
  });
});
