import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../config/config.js";
import { resolveLaunchAgentLabel } from "../../daemon/launchd-label.js";
import { resolveLaunchAgentEnvWrapperPath } from "../../daemon/launchd-service-files.js";
import type {
  GatewayServiceCommandConfig,
  GatewayServiceInstallArgs,
} from "../../daemon/service-types.js";
import { mockSystemAccountHome } from "../../daemon/service.test-helpers.js";
import { createCliRuntimeCapture } from "../test-runtime-capture.js";
import { addGatewayServiceCommands } from "./register-service-commands.js";

const { defaultRuntime, runtimeErrors, resetRuntimeCapture } = createCliRuntimeCapture();
const service = vi.hoisted(() => ({
  label: "LaunchAgent",
  loadedText: "loaded",
  notLoadedText: "not loaded",
  install: vi.fn<(args: GatewayServiceInstallArgs) => Promise<void>>(),
  isLoaded: vi.fn(async () => true),
  readCommand: vi.fn<() => Promise<GatewayServiceCommandConfig | null>>(),
  readDefinitionMutationCapability: vi.fn(async () => ({ kind: "writable" as const })),
}));

vi.mock("../../daemon/service.js", () => ({ resolveGatewayService: () => service }));
vi.mock("../../runtime.js", () => ({ defaultRuntime }));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let originalArgv: string[];
let entrypoint: string;

beforeEach(async () => {
  originalArgv = process.argv;
  const home = tempDirs.make("openclaw-install-wrapper-");
  const state = path.join(home, ".openclaw-wrapper-test");
  for (const [key, value] of Object.entries({
    HOME: home,
    OPENCLAW_HOME: "",
    OPENCLAW_PROFILE: "wrapper-test",
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
    OPENCLAW_WRAPPER: "",
    OPENCLAW_LAUNCHD_LABEL: "",
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENCLAW_GATEWAY_PASSWORD: "",
  })) {
    vi.stubEnv(key, value);
  }
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  mockSystemAccountHome();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
  resetRuntimeCapture();
  service.install.mockReset();
  service.install.mockResolvedValue(undefined);
  service.readCommand.mockReset();
  service.readCommand.mockResolvedValue(null);
  await fs.mkdir(state);
  await fs.writeFile(
    path.join(state, "openclaw.json"),
    JSON.stringify({ gateway: { mode: "local", auth: { mode: "none" } } }),
  );
  entrypoint = path.join(home, "dist", "index.js");
  await fs.mkdir(path.dirname(entrypoint));
  await fs.writeFile(entrypoint, "");
  process.argv = [process.execPath, entrypoint];
});

afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearConfigCache();
  clearRuntimeConfigSnapshot();
});

describe("registered gateway install --force wrapper selection", () => {
  it.each(["explicit", "persisted", "custom"] as const)(
    "selects a runnable service command for a %s wrapper",
    async (source) => {
      const wrapper =
        source === "custom"
          ? path.join(process.env.HOME!, "custom-wrapper.sh")
          : resolveLaunchAgentEnvWrapperPath(process.env, resolveLaunchAgentLabel(process.env));
      await fs.mkdir(path.dirname(wrapper), { recursive: true });
      await fs.writeFile(wrapper, '#!/bin/sh\nexec "$@"\n', { mode: 0o700 });
      if (source === "persisted") {
        vi.stubEnv("OPENCLAW_WRAPPER", undefined);
        service.readCommand.mockResolvedValue({
          programArguments: [wrapper, "gateway", "--port", "29453"],
          environment: { OPENCLAW_WRAPPER: wrapper, WRAPPER_TEST_VALUE: "retained" },
        });
      }
      const program = new Command().name("openclaw");
      addGatewayServiceCommands(program.command("gateway"));
      await program.parseAsync(
        [
          "gateway",
          "install",
          "--force",
          "--runtime",
          "node",
          "--port",
          "29453",
          "--json",
          ...(source === "persisted" ? [] : ["--wrapper", wrapper]),
        ],
        { from: "user" },
      );
      expect(runtimeErrors).toEqual([]);
      expect(service.install).toHaveBeenCalledOnce();
      const [installed] = service.install.mock.calls[0]!;
      if (source === "custom") {
        expect(installed.programArguments).toEqual([wrapper, "gateway", "--port", "29453"]);
        expect(installed.environment?.OPENCLAW_WRAPPER).toBe(wrapper);
      } else {
        expect(installed.programArguments).toContain(entrypoint);
        expect(installed.programArguments).not.toContain(wrapper);
        expect(installed.environment?.OPENCLAW_WRAPPER).toBeUndefined();
      }
      if (source === "persisted") {
        expect(installed.environment?.WRAPPER_TEST_VALUE).toBe("retained");
      }
    },
  );
});
