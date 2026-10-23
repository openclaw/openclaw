import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import { withMockedPlatform as onPlatform } from "../test-utils/vitest-spies.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const runExec = vi.fn();
const runCommandWithTimeout = vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>();
const note = vi.fn();
const validateSandboxContainerEngineTarget = vi.fn();
const resolveCodexHealthApi = vi.fn();
const probeCodexWorkspaceWriteSandbox = vi.fn();
const codexSandboxCommand = `codex sandbox -c 'sandbox_mode="workspace-write"' -c sandbox_workspace_write.network_access=false -- true`;

// mock-isolation: Doctor receives a synthetic health API without loading bundled runtimes.
vi.mock("../flows/bundled-health-checks.js", () => ({ resolveCodexHealthApi }));

// mock-isolation: Sandbox probes must not launch commands on the test host.
vi.mock("../process/exec.js", () => ({ runExec, runCommandWithTimeout }));

vi.mock("../agents/sandbox/constants.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/sandbox/constants.js")>(
    "../agents/sandbox/constants.js",
  )),
  DEFAULT_SANDBOX_BROWSER_IMAGE: "browser-image",
  DEFAULT_SANDBOX_COMMON_IMAGE: "common-image",
  DEFAULT_SANDBOX_IMAGE: "default-image",
}));

vi.mock("../agents/sandbox/config.js", async () => ({
  ...(await vi.importActual<typeof import("../agents/sandbox/config.js")>(
    "../agents/sandbox/config.js",
  )),
  resolveSandboxScope: vi.fn(() => "shared"),
}));

// mock-isolation: Synthetic engine descriptors keep probes independent of installed containers.
vi.mock("../agents/sandbox/docker.js", () => ({
  DOCKER_SANDBOX_ENGINE: { id: "docker", command: "docker", displayName: "Docker" },
  PODMAN_SANDBOX_ENGINE: { id: "podman", command: "podman", displayName: "Podman" },
  validateSandboxContainerEngineTarget,
}));

// mock-isolation: Capture Doctor notices without writing to the real terminal.
vi.mock("../../packages/terminal-core/src/note.js", () => ({ note }));

const { maybeRepairSandboxImages, noteCodexBwrapNamespaceWarnings } =
  await import("./doctor-sandbox.js");

describe("sandbox health", () => {
  const mockRuntime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  const mockPrompter: DoctorPrompter = {
    confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    } satisfies DoctorRepairMode,
  } as unknown as DoctorPrompter;

  beforeEach(() => {
    vi.clearAllMocks();
    runExec.mockResolvedValue({ stdout: "", stderr: "" });
    validateSandboxContainerEngineTarget.mockResolvedValue(undefined);
    resolveCodexHealthApi.mockReturnValue({
      status: "available",
      api: { probeCodexWorkspaceWriteSandbox },
    });
    probeCodexWorkspaceWriteSandbox.mockResolvedValue({
      status: "ok",
      command: codexSandboxCommand,
    });
  });

  function createSandboxConfig(mode: "off" | "all" | "non-main", network?: string): OpenClawConfig {
    return {
      agents: { defaults: { sandbox: { mode, ...(network ? { docker: { network } } : {}) } } },
    };
  }

  it.each(["non-main", "off"] as const)(
    "reports unavailable Docker with sandbox mode %s",
    async (mode) => {
      runExec.mockRejectedValue(new Error("Docker not installed"));
      await maybeRepairSandboxImages(createSandboxConfig(mode), mockRuntime, mockPrompter);
      if (mode === "off") {
        expect(note).not.toHaveBeenCalled();
      } else {
        expect(note.mock.calls[0]!).toEqual([
          [
            'Sandbox mode is enabled (mode: "non-main") but Docker is not available.',
            "Docker is required for sandbox mode to function.",
            "Isolated sessions (automations, sub-agents) will fail without Docker.",
            "",
            "Options:",
            "- Install Docker and restart the gateway",
            "- Disable sandbox mode: openclaw config set agents.defaults.sandbox.mode off",
          ].join("\n"),
          "Sandbox",
        ]);
      }
    },
  );

  it("validates the explicit Podman target before checking images", async () => {
    const cfg = createSandboxConfig("all");
    cfg.agents!.defaults!.sandbox!.backend = "podman";
    validateSandboxContainerEngineTarget.mockRejectedValue(
      Object.assign(new Error("unsupported remote Podman connection"), { code: "INVALID_CONFIG" }),
    );

    await expect(maybeRepairSandboxImages(cfg, mockRuntime, mockPrompter)).rejects.toThrow(
      "unsupported remote Podman connection",
    );

    expect(runExec).toHaveBeenCalledWith("podman", ["info"], { timeoutMs: 5_000 });
    expect(validateSandboxContainerEngineTarget).toHaveBeenCalledWith({
      id: "podman",
      command: "podman",
      displayName: "Podman",
    });
  });

  it("repairs sandbox images without running Codex namespace diagnostics", async () => {
    await onPlatform("linux", async () => {
      await maybeRepairSandboxImages(createSandboxConfig("all"), mockRuntime, mockPrompter);
    });
    expect(runExec).toHaveBeenCalledWith("docker", ["image", "inspect", "default-image"], {
      timeoutMs: 5_000,
    });
    expect(runExec.mock.calls.some(([command]) => command === "unshare")).toBe(false);
    expect(resolveCodexHealthApi).not.toHaveBeenCalled();
    expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
  });

  it.each([
    ["unavailable engine", "linux", createSandboxConfig("all"), false],
    ["non-Linux host", "darwin", createSandboxConfig("all"), true],
    ["disabled sandbox", "linux", createSandboxConfig("off"), true],
    ["unconfigured sandbox", "linux", {}, true],
    [
      "non-container backend",
      "linux",
      { agents: { defaults: { sandbox: { mode: "all", backend: "ssh" } } } },
      true,
    ],
  ] as const)("skips Codex diagnostics for %s", async (_name, platform, cfg, engine) => {
    if (!engine) {
      runExec.mockRejectedValue(new Error("Docker not installed"));
    }
    await onPlatform(platform, () => noteCodexBwrapNamespaceWarnings(cfg));
    expect(runExec.mock.calls.some(([command]) => command === "unshare")).toBe(false);
    expect(resolveCodexHealthApi).not.toHaveBeenCalled();
    expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it.each([
    ["unshare", "user", "unshare: write failed /proc/self/uid_map: Operation not permitted"],
    ["Codex", "network", "bwrap: loopback: Failed RTM_NEWADDR: No child processes"],
    ["Codex", "user", "bwrap: setting up uid map: Permission denied"],
  ] as const)("reports %s %s namespace failures", async (stage, kind, denial) => {
    if (stage === "unshare") {
      runExec.mockImplementation(async (command: string, args: string[]) => {
        if (command === "docker" && args[0] === "version") {
          return { stdout: "24.0.0", stderr: "" };
        }
        if (command === "unshare") {
          throw Object.assign(new Error("unshare failed"), { stderr: denial });
        }
        return { stdout: "", stderr: "" };
      });
    } else {
      probeCodexWorkspaceWriteSandbox.mockResolvedValue({
        status: "denied",
        command: codexSandboxCommand,
        denial,
      });
    }
    const cfg = createSandboxConfig("all");
    cfg.plugins = { entries: { codex: { enabled: true } } };
    const options = { env: { PATH: "/service/bin" }, cwd: "/service/workspace" };
    await onPlatform("linux", () => noteCodexBwrapNamespaceWarnings(cfg, options));
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Codex bwrap ${kind} namespace check failed`),
      "Sandbox",
    );
    if (stage === "unshare") {
      expect(note).toHaveBeenCalledWith(
        expect.stringContaining("kernel.apparmor_restrict_unprivileged_userns=0"),
        "Sandbox",
      );
      expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
    } else {
      const message = note.mock.calls[0]![0];
      expect(message).toContain(`Codex bwrap ${kind} namespace check failed`);
      expect(message).toContain(`Check result: ${denial}`);
      expect(message).toContain(`Check command: ${codexSandboxCommand}`);
      expect(resolveCodexHealthApi).toHaveBeenCalledExactlyOnceWith({ cfg, ...options });
      expect(probeCodexWorkspaceWriteSandbox).toHaveBeenCalledExactlyOnceWith({
        cfg,
        env: options.env,
      });
    }
  });

  it.each(["inconclusive", "unavailable", "older"] as const)(
    "reports %s probes as unverified without diagnosing namespace policy",
    async (scenario) => {
      const reason = {
        inconclusive: "Codex sandbox probe timed out.",
        unavailable: "The selected Codex health API could not be loaded.",
        older: "The selected Codex plugin does not provide a workspace-write sandbox check.",
      }[scenario];
      if (scenario === "unavailable") {
        resolveCodexHealthApi.mockReturnValue({
          status: "unavailable",
          reason,
          reportAvailability: true,
        });
      } else if (scenario === "older") {
        resolveCodexHealthApi.mockReturnValue({ status: "available", api: {} });
      }
      probeCodexWorkspaceWriteSandbox.mockResolvedValue({
        status: "inconclusive",
        command: codexSandboxCommand,
        reason,
      });
      await onPlatform("linux", () => noteCodexBwrapNamespaceWarnings(createSandboxConfig("all")));
      const message = note.mock.calls[0]![0];
      expect(message).toContain("Doctor could not verify the Codex bwrap network sandbox.");
      expect(message).toContain(`Check result: ${reason}`);
      expect(message).not.toContain("namespace check failed");
      expect(message).not.toContain("AppArmor");
      if (scenario === "inconclusive") {
        expect(message).toContain(`Check command: ${codexSandboxCommand}`);
      } else {
        expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
      }
    },
  );

  it.each(["not-configured", "ok", "skipped", "egress-enabled"] as const)(
    "does not emit a network note for a %s Codex sandbox probe",
    async (status) => {
      if (status === "not-configured") {
        resolveCodexHealthApi.mockReturnValue({ status });
      } else if (status === "skipped") {
        probeCodexWorkspaceWriteSandbox.mockResolvedValue({
          status,
          reason: "A remote Codex transport is configured.",
        });
      }
      await onPlatform("linux", () =>
        noteCodexBwrapNamespaceWarnings(
          status === "egress-enabled"
            ? createSandboxConfig("all", "bridge")
            : createSandboxConfig("all"),
        ),
      );
      expect(note).not.toHaveBeenCalled();
      if (status === "not-configured" || status === "egress-enabled") {
        expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
      }
      if (status === "egress-enabled") {
        expect(resolveCodexHealthApi).not.toHaveBeenCalled();
      }
    },
  );

  describe("sandbox setup script execution", () => {
    const dirs = useAutoCleanupTempDirTracker(afterEach);
    const scriptRel = path.join("scripts", "sandbox-setup.sh");

    beforeEach(() => {
      runExec.mockImplementation(async (command: string, args: string[]) => {
        if (command === "docker" && args[0] === "image") {
          throw Object.assign(new Error("missing image"), { stderr: "No such image" });
        }
        if ((command === "docker" && args[0] === "version") || command === "unshare") {
          return { stdout: "", stderr: "" };
        }
        throw new Error(`Unexpected sandbox probe: ${command} ${args.join(" ")}`);
      });
      runCommandWithTimeout.mockResolvedValue({
        stdout: "",
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      });
      vi.mocked(mockPrompter.confirmRuntimeRepair).mockResolvedValue(true);
    });

    afterEach(() => {
      runExec.mockReset();
      runCommandWithTimeout.mockReset();
      vi.mocked(mockPrompter.confirmRuntimeRepair).mockReset().mockResolvedValue(false);
    });

    function mkTmp(prefix: string): string {
      return fs.realpathSync(dirs.make(prefix));
    }

    function mkRepo(prefix: string): string {
      const repo = mkTmp(prefix);
      fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(repo, scriptRel), "#!/bin/sh\n");
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "openclaw" }));
      return repo;
    }

    it.each([false, true])(
      "locates setup scripts (installed package=%s)",
      async (installedPackage) => {
        let argv1: string, cwd: string, expectedRoot: string | null;
        if (installedPackage) {
          const installed = mkTmp("ocsbx-installed-");
          fs.writeFileSync(
            path.join(installed, "package.json"),
            JSON.stringify({ name: "openclaw" }),
          );
          argv1 = path.join(installed, "openclaw.mjs");
          fs.writeFileSync(argv1, "");
          cwd = expectedRoot = mkRepo("ocsbx-source-");
          expect(resolveOpenClawPackageRootSync({ argv1, cwd })).toBe(installed);
        } else {
          // Keep an enclosing checkout above TMPDIR outside package discovery.
          cwd = path.join(mkTmp("ocsbx-none-"), "node_modules", ".bin");
          fs.mkdirSync(cwd, { recursive: true });
          argv1 = path.join(cwd, "openclaw");
          fs.writeFileSync(argv1, "");
          expectedRoot = null;
        }
        const originalArgv = process.argv;
        const argv = [...originalArgv];
        argv[1] = argv1;
        const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(cwd);
        try {
          process.argv = argv;
          await maybeRepairSandboxImages(createSandboxConfig("all"), mockRuntime, mockPrompter);
        } finally {
          process.argv = originalArgv;
          cwdSpy.mockRestore();
        }
        if (expectedRoot === null) {
          expect(runCommandWithTimeout).not.toHaveBeenCalled();
          expect(note).toHaveBeenCalledWith(
            "Unable to locate scripts/sandbox-setup.sh. Run it from the repo root.",
            "Sandbox",
          );
          expect(mockRuntime.log).not.toHaveBeenCalled();
        } else {
          expect(runCommandWithTimeout).toHaveBeenCalledExactlyOnceWith(
            ["bash", path.join(expectedRoot, scriptRel)],
            { timeoutMs: 20 * 60 * 1000, cwd: expectedRoot },
          );
          expect(vi.mocked(mockRuntime.log).mock.calls).toEqual([
            ["Running scripts/sandbox-setup.sh..."],
            ["Completed scripts/sandbox-setup.sh."],
          ]);
        }
        expect(mockRuntime.error).not.toHaveBeenCalled();
      },
    );
  });
});
