import "../flows/doctor-health.test-support.js";
import fs from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runCommandWithRuntime } from "../cli/cli-utils.js";
import { useDoctorHealthFixture } from "../flows/doctor-health.fixture.test-support.js";
import { mocks } from "../flows/doctor-health.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import * as configFlow from "./doctor-config-flow.js";
import { doctorCommand } from "./doctor.js";

const downloads = vi.hoisted(() => ({ specs: [] as string[] }));
vi.mock("../plugins/install.js", async (original) => ({
  ...(await original<typeof import("../plugins/install.js")>()),
  installPluginFromNpmSpec: async (params: { spec: string }) => {
    downloads.specs.push(params.spec);
    return { ok: false as const, error: "Synthetic package registry is offline" };
  },
}));
vi.mock("../plugins/clawhub.js", async (original) => ({
  ...(await original<typeof import("../plugins/clawhub.js")>()),
  installPluginFromClawHub: async (params: { spec: string }) => {
    downloads.specs.push(params.spec);
    return { ok: false as const, error: "Synthetic package registry is offline" };
  },
}));

const { loadAndMaybeMigrateDoctorConfig } = await vi.importActual<typeof configFlow>(
  "./doctor-config-flow.js",
);
useDoctorHealthFixture();
const stdinIsTTY = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
beforeEach(() => Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true }));
afterEach(() => {
  vi.restoreAllMocks();
  if (stdinIsTTY) {
    Object.defineProperty(process.stdin, "isTTY", stdinIsTTY);
  } else {
    Reflect.deleteProperty(process.stdin, "isTTY");
  }
});

it.each([
  { options: { nonInteractive: true }, shouldDownload: false },
  { options: {}, shouldDownload: false },
  { options: { nonInteractive: true, repair: true }, shouldDownload: true },
])("requires repair consent for unattended plugin downloads: $options", async ({ options, shouldDownload }) => {
  downloads.specs.length = 0;
  await withOpenClawTestState(
    { scenario: "minimal", env: { TELNYX_API_KEY: "synthetic-doctor-plugin-key" } },
    async (state) => {
      mocks.emulateNativeInstall = false;
      fs.writeFileSync(state.path("package.json"), '{"name":"openclaw"}');
      mocks.packageRoot.mockReturnValue(state.root);
      await state.writeConfig({
        agents: { ownership: "explicit", entries: { main: { workspace: state.workspaceDir } } },
        gateway: { mode: "local", auth: { mode: "none" } },
      });
      // Exercise Doctor's invocation and real preflight; only external package I/O is fixed.
      vi.spyOn(configFlow, "loadAndMaybeMigrateDoctorConfig").mockImplementation(
        loadAndMaybeMigrateDoctorConfig,
      );
      const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
      await runCommandWithRuntime(runtime, () => doctorCommand(runtime, options));
      expect(mocks.runContributions).toHaveBeenCalledOnce();
      if (shouldDownload) {
        expect(downloads.specs).toContain("@telnyx/openclaw-provider@0.2.0");
      } else {
        expect(downloads.specs).toEqual([]);
      }
    },
  );
});
