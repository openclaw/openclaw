import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfigFileSnapshot } from "../../config/io.snapshot-shared.js";
import type { GatewayServiceState } from "../../daemon/service-types.js";
import { prepareUpdateRestart } from "./update-command-restart-context.js";
import type { ManagedGatewayUpdateVerdict } from "./update-command-service-context-types.js";

const mocks = vi.hoisted(() => ({
  readState: vi.fn<() => Promise<GatewayServiceState>>(),
  revalidate: vi.fn<() => Promise<ManagedGatewayUpdateVerdict>>(),
}));

vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: () => ({}),
}));
vi.mock("./update-command-service-plan.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-plan.js")>()),
  isGatewayServiceManagementAllowedForUpdate: () => true,
  readGatewayServiceStateForUpdate: mocks.readState,
  resolveGatewayServiceManagementBlockMessageForUpdate: () => undefined,
  resolveUpdatedGatewayRestartPort: () => 18789,
}));
vi.mock("./update-command-service-revalidation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./update-command-service-revalidation.js")>()),
  revalidateManagedGatewayServiceAfterUpdate: mocks.revalidate,
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("prepareUpdateRestart", () => {
  it.each([
    {
      mode: "npm",
      installed: true,
      loaded: false,
      stopped: false,
      owned: true,
      prepare: true,
      captured: true,
    },
    {
      mode: "npm",
      installed: false,
      loaded: false,
      stopped: false,
      owned: true,
      prepare: false,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: false,
      stopped: false,
      owned: true,
      prepare: false,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: true,
      stopped: false,
      owned: false,
      prepare: false,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: true,
      stopped: false,
      owned: true,
      prepare: true,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: false,
      stopped: true,
      owned: true,
      prepare: true,
      captured: true,
    },
    {
      mode: "git",
      installed: true,
      loaded: true,
      stopped: false,
      owned: true,
      prepare: true,
      captured: false,
    },
  ] as const)(
    "prepares the native install environment for $mode (installed=$installed, loaded=$loaded, stopped=$stopped, owned=$owned)",
    async ({ mode, installed, loaded, stopped, owned, prepare, captured }) => {
      vi.stubEnv("OPENCLAW_STATE_DIR", "/caller/state");
      const serviceEnv = { OPENCLAW_STATE_DIR: "/managed/state" };
      const verdict: ManagedGatewayUpdateVerdict = owned
        ? { kind: "owned", root: "/installed", fingerprint: "fixture", refreshDefinition: true }
        : { kind: "unresolved", root: "/installed", fingerprint: "fixture" };
      mocks.readState.mockResolvedValue({
        installed,
        loadState: { status: loaded ? "loaded" : "not-loaded" },
        running: false,
        env: serviceEnv,
        command: { programArguments: ["node", "/installed/entry.js"], environment: serviceEnv },
      });
      mocks.revalidate.mockResolvedValue(verdict);
      const result = await prepareUpdateRestart(
        {
          root: "/installed",
          result: { status: "ok", mode, steps: [], durationMs: 0 },
          shouldRestart: true,
          updateStepTimeoutMs: 1000,
          assertCurrent: () => {},
          preManagedServiceStop: {
            stopped,
            inspected: true,
            runtimeInspected: true,
            running: false,
            serviceEnv: captured ? serviceEnv : undefined,
            serviceUpdateVerdict: verdict,
          },
        },
        createConfigFileSnapshot({
          path: "/managed/state/openclaw.json",
          exists: true,
          raw: "{}",
          parsed: {},
          sourceConfig: {},
          runtimeConfig: {},
          valid: true,
          issues: [],
          warnings: [],
          legacyIssues: [],
        }),
      );
      expect(mocks.readState).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          OPENCLAW_STATE_DIR: captured ? "/managed/state" : "/caller/state",
        }),
        1000,
        expect.objectContaining({ assertCurrent: expect.any(Function) }),
      );
      expect(result.gatewayServiceInstallEnv?.OPENCLAW_STATE_DIR).toBe(
        prepare ? "/managed/state" : undefined,
      );
      expect(result.refreshGatewayServiceEnv).toBe(prepare);
    },
  );
});
