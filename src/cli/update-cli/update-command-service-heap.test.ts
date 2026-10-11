import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { runUtf8CommandWithTimeout } from "../../process/exec.js";
import { resolveUpdatedInstallCommandEnv } from "./update-command-service-env.js";
import { readGatewayServiceStateForUpdate } from "./update-command-service-plan.js";

const dirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());
const nodeOptionsProbe = "console.log(process.env.NODE_OPTIONS ?? '')";

it.each([
  { name: "service argv", caller: "", service: "", argv: ["--max-old-space-size=160"] },
  {
    name: "service environment",
    caller: "--max-old-space-size=96",
    service: "--max-old-space-size=160",
    argv: [],
  },
  {
    name: "empty service environment",
    caller: "--require=/missing-preload.cjs --max-old-space-size=160",
    service: "",
    argv: [],
  },
  {
    name: "argv overriding environment",
    caller: "",
    service: "--max-old-space-size=96",
    argv: ["--max_old_space_size", "160"],
  },
])(
  "carries $name through service capture into an update child",
  async ({ caller, service, argv }) => {
    const home = dirs.make("openclaw-update-heap-");
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: home });
    vi.spyOn(os, "homedir").mockReturnValue(home);
    const env = {
      HOME: home,
      USERPROFILE: home,
      OPENCLAW_STATE_DIR: path.join(home, ".openclaw"),
      NODE_OPTIONS: caller,
    };
    const state = await readGatewayServiceStateForUpdate(
      createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, ...argv, path.join(home, "openclaw.mjs"), "gateway"],
          environment: { NODE_OPTIONS: service },
        }),
      }),
      env,
    );
    const child = await runUtf8CommandWithTimeout([process.execPath, "-e", nodeOptionsProbe], {
      baseEnv: {},
      env: resolveUpdatedInstallCommandEnv({ processEnv: env, serviceEnv: state.env }),
      timeoutMs: 10_000,
    });
    expect(child.code, child.stderr).toBe(0);
    const heapControls = child.stdout
      .trim()
      .split(/\s+/u)
      .filter((arg) => arg.startsWith("--max-old-space-size="));
    expect(heapControls.at(-1)).toBe("--max-old-space-size=160");
  },
);
