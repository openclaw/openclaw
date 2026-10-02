// Doctor sandbox tests cover warnings when sandbox mode is enabled without Docker availability.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const runExec = vi.fn();
const runCommandWithTimeout = vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>();
const note = vi.fn();
const inspectLegacySandboxRegistryFiles = vi.fn();
const migrateLegacySandboxRegistryFiles = vi.fn();
const validateSandboxContainerEngineTarget = vi.fn();
const resolveCodexHealthApi = vi.fn();
const probeCodexWorkspaceWriteSandbox = vi.fn();
const codexSandboxCommand = `codex sandbox -c 'sandbox_mode="workspace-write"' -c sandbox_workspace_write.network_access=false -- true`;

vi.mock("../flows/bundled-health-checks.js", () => ({
  resolveCodexHealthApi,
}));

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout,
}));

vi.mock("../agents/sandbox.js", () => ({
  DEFAULT_SANDBOX_BROWSER_IMAGE: "browser-image",
  DEFAULT_SANDBOX_COMMON_IMAGE: "common-image",
  DEFAULT_SANDBOX_IMAGE: "default-image",
  resolveSandboxScope: vi.fn(() => "shared"),
}));

vi.mock("../agents/sandbox/docker.js", () => ({
  DOCKER_SANDBOX_ENGINE: {
    id: "docker",
    command: "docker",
    displayName: "Docker",
  },
  PODMAN_SANDBOX_ENGINE: {
    id: "podman",
    command: "podman",
    displayName: "Podman",
  },
  validateSandboxContainerEngineTarget,
}));

vi.mock("./doctor-sandbox-legacy-registry.js", () => ({
  inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles,
}));

vi.mock("../../packages/terminal-core/src/note.js", () => ({
  note,
}));

const {
  legacySandboxRegistryInspectionToHealthFinding,
  legacySandboxRegistryInspectionToRepairEffect,
  maybeRepairSandboxImages,
  maybeRepairSandboxRegistryFiles,
  noteCodexBwrapNamespaceWarnings,
} = await import("./doctor-sandbox.js");

describe("sandbox health", () => {
  const mockRuntime: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };

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
    validateSandboxContainerEngineTarget.mockResolvedValue(undefined);
    inspectLegacySandboxRegistryFiles.mockResolvedValue([]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([]);
    resolveCodexHealthApi.mockReturnValue({
      status: "available",
      api: { probeCodexWorkspaceWriteSandbox },
    });
    probeCodexWorkspaceWriteSandbox.mockResolvedValue({
      status: "ok",
      command: codexSandboxCommand,
    });
  });

  function createSandboxConfig(mode: "off" | "all" | "non-main"): OpenClawConfig {
    return {
      agents: {
        defaults: {
          sandbox: {
            mode,
          },
        },
      },
    };
  }

  function createSandboxConfigWithDockerNetwork(network: string): OpenClawConfig {
    return {
      agents: {
        defaults: {
          sandbox: {
            mode: "all",
            docker: {
              network,
            },
          },
        },
      },
    };
  }

  async function runSandboxRepair(params: {
    mode: "off" | "all" | "non-main";
    dockerAvailable: boolean;
  }) {
    if (params.dockerAvailable) {
      runExec.mockResolvedValue({ stdout: "24.0.0", stderr: "" });
    } else {
      runExec.mockRejectedValue(new Error("Docker not installed"));
    }
    await maybeRepairSandboxImages(createSandboxConfig(params.mode), mockRuntime, mockPrompter);
  }

  function firstNoteCall() {
    const noteCall = note.mock.calls[0];
    if (noteCall === undefined) {
      throw new Error("expected sandbox warning note");
    }
    return noteCall;
  }

  it("warns when sandbox mode is enabled but Docker is not available", async () => {
    await runSandboxRepair({ mode: "non-main", dockerAvailable: false });

    const noteCall = firstNoteCall();
    expect(noteCall).toEqual([
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
  });

  it("does not warn when sandbox mode is off", async () => {
    await runSandboxRepair({ mode: "off", dockerAvailable: false });

    // No warning needed when sandbox is off
    expect(note).not.toHaveBeenCalled();
  });

  it("validates the explicit Podman target before checking images", async () => {
    const cfg = createSandboxConfig("all");
    cfg.agents!.defaults!.sandbox!.backend = "podman";
    runExec.mockResolvedValue({ stdout: "", stderr: "" });
    validateSandboxContainerEngineTarget.mockRejectedValue(
      Object.assign(new Error("unsupported remote Podman connection"), {
        code: "INVALID_CONFIG",
      }),
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
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExec.mockResolvedValue({ stdout: "", stderr: "" });
    try {
      await maybeRepairSandboxImages(createSandboxConfig("all"), mockRuntime, mockPrompter);
    } finally {
      platformSpy.mockRestore();
    }
    expect(runExec).toHaveBeenCalledWith("docker", ["image", "inspect", "default-image"], {
      timeoutMs: 5_000,
    });
    expect(runExec.mock.calls.some(([command]) => command === "unshare")).toBe(false);
    expect(resolveCodexHealthApi).not.toHaveBeenCalled();
    expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unavailable engine",
      platform: "linux",
      cfg: createSandboxConfig("all"),
      engine: false,
    },
    { name: "non-Linux host", platform: "darwin", cfg: createSandboxConfig("all"), engine: true },
    { name: "disabled sandbox", platform: "linux", cfg: createSandboxConfig("off"), engine: true },
    { name: "unconfigured sandbox", platform: "linux", cfg: {}, engine: true },
    {
      name: "non-container backend",
      platform: "linux",
      cfg: { agents: { defaults: { sandbox: { mode: "all", backend: "ssh" } } } },
      engine: true,
    },
  ] as const)("skips Codex diagnostics for $name", async ({ platform, cfg, engine }) => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    if (engine) {
      runExec.mockResolvedValue({ stdout: "", stderr: "" });
    } else {
      runExec.mockRejectedValue(new Error("Docker not installed"));
    }
    try {
      await noteCodexBwrapNamespaceWarnings(cfg);
    } finally {
      platformSpy.mockRestore();
    }
    expect(runExec.mock.calls.some(([command]) => command === "unshare")).toBe(false);
    expect(resolveCodexHealthApi).not.toHaveBeenCalled();
    expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("warns when Codex bwrap namespaces are blocked on a sandboxed Linux host", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "version") {
        return { stdout: "24.0.0", stderr: "" };
      }
      if (command === "unshare") {
        throw Object.assign(new Error("unshare failed"), {
          stderr: "unshare: write failed /proc/self/uid_map: Operation not permitted",
        });
      }
      return { stdout: "", stderr: "" };
    });

    try {
      await noteCodexBwrapNamespaceWarnings(createSandboxConfig("all"));
    } finally {
      platformSpy.mockRestore();
    }

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Codex bwrap user namespace probe failed"),
      "Sandbox",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("kernel.apparmor_restrict_unprivileged_userns=0"),
      "Sandbox",
    );
    expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
  });

  it("warns about Codex loopback denial even when the user namespace probe succeeds", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExec.mockResolvedValue({ stdout: "", stderr: "" });
    const denial = "bwrap: loopback: Failed RTM_NEWADDR: No child processes";
    probeCodexWorkspaceWriteSandbox.mockResolvedValue({
      status: "denied",
      command: codexSandboxCommand,
      denial,
    });
    const cfg = createSandboxConfig("all");
    cfg.plugins = { entries: { codex: { enabled: true } } };
    const options = { env: { PATH: "/service/bin" }, cwd: "/service/workspace" };

    try {
      await noteCodexBwrapNamespaceWarnings(cfg, options);
    } finally {
      platformSpy.mockRestore();
    }

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Codex bwrap network namespace probe failed"),
      "Sandbox",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Probe command: ${codexSandboxCommand}`),
      "Sandbox",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining(`Probe result: ${denial}`),
      "Sandbox",
    );
    expect(resolveCodexHealthApi).toHaveBeenCalledExactlyOnceWith({ cfg, ...options });
    expect(probeCodexWorkspaceWriteSandbox).toHaveBeenCalledExactlyOnceWith({
      cfg,
      env: options.env,
    });
  });

  it("reports a Codex uid-map denial as a user namespace failure", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExec.mockResolvedValue({ stdout: "", stderr: "" });
    const denial = "bwrap: setting up uid map: Permission denied";
    probeCodexWorkspaceWriteSandbox.mockResolvedValue({
      status: "denied",
      command: codexSandboxCommand,
      denial,
    });
    try {
      await noteCodexBwrapNamespaceWarnings(createSandboxConfig("all"));
    } finally {
      platformSpy.mockRestore();
    }
    const message = firstNoteCall()[0];
    expect(message).toContain("Codex bwrap user namespace probe failed");
    expect(message).toContain(`Probe result: ${denial}`);
    expect(message).toContain(`Probe command: ${codexSandboxCommand}`);
  });

  it("skips the Codex bwrap network namespace probe when Docker sandbox egress is enabled", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "version") {
        return { stdout: "24.0.0", stderr: "" };
      }
      if (command === "unshare") {
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    try {
      await noteCodexBwrapNamespaceWarnings(createSandboxConfigWithDockerNetwork("bridge"));
    } finally {
      platformSpy.mockRestore();
    }

    expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
    expect(resolveCodexHealthApi).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "an inconclusive probe",
      selection: { status: "available", api: { probeCodexWorkspaceWriteSandbox } },
      reason: "Codex sandbox probe timed out.",
      ranProbe: true,
    },
    {
      name: "an unavailable selected plugin",
      selection: {
        status: "unavailable",
        reason: "The selected Codex health API could not be loaded.",
        reportAvailability: true,
      },
      reason: "The selected Codex health API could not be loaded.",
      ranProbe: false,
    },
    {
      name: "an older selected plugin without a sandbox probe",
      selection: { status: "available", api: {} },
      reason: "The selected Codex plugin does not provide a workspace-write sandbox probe.",
      ranProbe: false,
    },
  ])("reports $name as unverified without diagnosing namespace policy", async (scenario) => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExec.mockResolvedValue({ stdout: "", stderr: "" });
    resolveCodexHealthApi.mockReturnValue(scenario.selection);
    probeCodexWorkspaceWriteSandbox.mockResolvedValue({
      status: "inconclusive",
      command: codexSandboxCommand,
      reason: scenario.reason,
    });
    try {
      await noteCodexBwrapNamespaceWarnings(createSandboxConfig("all"));
    } finally {
      platformSpy.mockRestore();
    }
    const message = firstNoteCall()[0];
    expect(message).toContain("Doctor could not verify the Codex bwrap network sandbox.");
    expect(message).toContain(`Probe result: ${scenario.reason}`);
    expect(message).not.toContain("namespace probe failed");
    expect(message).not.toContain("AppArmor");
    if (scenario.ranProbe) {
      expect(message).toContain(`Probe command: ${codexSandboxCommand}`);
    } else {
      expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
    }
  });

  it.each(["not-configured", "ok", "skipped"] as const)(
    "does not emit a network note for a %s Codex sandbox probe",
    async (status) => {
      const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
      runExec.mockResolvedValue({ stdout: "", stderr: "" });
      if (status === "not-configured") {
        resolveCodexHealthApi.mockReturnValue({ status });
      } else {
        probeCodexWorkspaceWriteSandbox.mockResolvedValue(
          status === "ok"
            ? { status, command: codexSandboxCommand }
            : { status, reason: "A remote Codex transport is configured." },
        );
      }
      try {
        await noteCodexBwrapNamespaceWarnings(createSandboxConfig("all"));
      } finally {
        platformSpy.mockRestore();
      }
      expect(note).not.toHaveBeenCalled();
      if (status === "not-configured") {
        expect(probeCodexWorkspaceWriteSandbox).not.toHaveBeenCalled();
      }
    },
  );

  describe("sandbox setup script execution", () => {
    const created: string[] = [];
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
      for (const dir of created.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    function mkTmp(prefix: string): string {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      created.push(dir);
      // Resolve macOS /var → /private/var so expectations match realpath output.
      return fs.realpathSync(dir);
    }

    function mkRepo(prefix: string): string {
      const repo = mkTmp(prefix);
      fs.mkdirSync(path.join(repo, "scripts"), { recursive: true });
      fs.writeFileSync(path.join(repo, scriptRel), "#!/bin/sh\n");
      fs.writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "openclaw" }));
      return repo;
    }

    type ScriptScenario = {
      name: string;
      setup: () => { argv1: string; cwd: string; expectedRoot: string | null; firstRoot?: string };
    };

    it.each<ScriptScenario>([
      {
        name: "follows a symlinked launcher to find scripts/ in the real repo",
        setup: () => {
          const repo = mkRepo("ocsbx-repo-");
          const entry = path.join(repo, "openclaw.mjs");
          fs.writeFileSync(entry, "");
          const binDir = mkTmp("ocsbx-bin-");
          const launcher = path.join(binDir, "openclaw");
          fs.symlinkSync(entry, launcher);
          return { argv1: launcher, cwd: binDir, expectedRoot: repo };
        },
      },
      {
        name: "still resolves a script relative to a non-symlinked launcher dir",
        setup: () => {
          const repo = mkRepo("ocsbx-direct-");
          const entry = path.join(repo, "openclaw.mjs");
          fs.writeFileSync(entry, "");
          return { argv1: entry, cwd: os.tmpdir(), expectedRoot: repo };
        },
      },
      {
        name: "does not execute when the script is unreachable from cwd or the launcher",
        setup: () => {
          // Keep an enclosing checkout above TMPDIR outside package discovery.
          const binDir = path.join(mkTmp("ocsbx-none-"), "node_modules", ".bin");
          fs.mkdirSync(binDir, { recursive: true });
          const launcher = path.join(binDir, "openclaw");
          fs.writeFileSync(launcher, "");
          return { argv1: launcher, cwd: binDir, expectedRoot: null };
        },
      },
      {
        name: "falls back to cwd when the launcher path does not resolve to a repo",
        setup: () => {
          const repo = mkRepo("ocsbx-missing-argv1-");
          return { argv1: "/nonexistent-ocsbx/bin/openclaw", cwd: repo, expectedRoot: repo };
        },
      },
      {
        name: "keeps searching cwd after a first-root lookup finds a package without the script",
        setup: () => {
          const installed = mkTmp("ocsbx-installed-");
          fs.writeFileSync(
            path.join(installed, "package.json"),
            JSON.stringify({ name: "openclaw" }),
          );
          const entry = path.join(installed, "openclaw.mjs");
          fs.writeFileSync(entry, "");
          // An installed package can omit scripts while source cwd still has them.
          const repo = mkRepo("ocsbx-source-");
          return { argv1: entry, cwd: repo, expectedRoot: repo, firstRoot: installed };
        },
      },
    ])("$name", async ({ setup }) => {
      const { argv1, cwd, expectedRoot, firstRoot } = setup();
      if (firstRoot !== undefined) {
        expect(resolveOpenClawPackageRootSync({ argv1, cwd })).toBe(firstRoot);
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
    });
  });
});

describe("maybeRepairSandboxRegistryFiles", () => {
  const mockPrompter = {
    shouldRepair: false,
  } as DoctorPrompter;

  beforeEach(() => {
    vi.clearAllMocks();
    inspectLegacySandboxRegistryFiles.mockResolvedValue([]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([]);
  });

  it("warns about legacy registry files without migrating outside doctor --fix", async () => {
    inspectLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        path: "/tmp/openclaw/sandbox/containers.json",
        source: "monolithic",
        exists: true,
        valid: true,
        entries: 2,
      },
    ]);

    await maybeRepairSandboxRegistryFiles(mockPrompter);

    expect(migrateLegacySandboxRegistryFiles).not.toHaveBeenCalled();
    expect(note).toHaveBeenCalledWith(
      [
        "Legacy sandbox registry files detected.",
        "- containers monolithic: /tmp/openclaw/sandbox/containers.json (2 entries)",
        "Run openclaw doctor --fix to migrate them to SQLite.",
      ].join("\n"),
      "Sandbox",
    );
  });

  it("migrates legacy registry files during doctor --fix", async () => {
    inspectLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        path: "/tmp/openclaw/sandbox/containers.json",
        source: "monolithic",
        exists: true,
        valid: true,
        entries: 2,
      },
    ]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        status: "migrated",
        entries: 2,
      },
    ]);

    await maybeRepairSandboxRegistryFiles({
      ...mockPrompter,
      shouldRepair: true,
    } as DoctorPrompter);

    expect(migrateLegacySandboxRegistryFiles).toHaveBeenCalledTimes(1);
    expect(note).toHaveBeenCalledWith(
      "- Migrated containers registry into 2 SQLite rows.",
      "Doctor changes",
    );
  });

  it("maps legacy registry files to structured findings and dry-run effects", () => {
    const monolithicFile = {
      kind: "containers",
      path: "/tmp/openclaw/sandbox/containers.json",
      source: "monolithic",
      exists: true,
      valid: true,
      entries: 2,
    } as const;
    const shardedFile = {
      ...monolithicFile,
      path: "/tmp/openclaw/sandbox/containers",
      source: "sharded",
    } as const;

    expect(legacySandboxRegistryInspectionToHealthFinding(monolithicFile)).toEqual(
      expect.objectContaining({
        checkId: "core/doctor/sandbox/registry-files",
        severity: "warning",
        path: "/tmp/openclaw/sandbox/containers.json",
        fixHint: expect.stringContaining("openclaw doctor --fix"),
      }),
    );
    expect(legacySandboxRegistryInspectionToRepairEffect(monolithicFile)).toEqual({
      kind: "state",
      action: "would-migrate-legacy-sandbox-registry",
      target: "/tmp/openclaw/sandbox/containers.json",
      dryRunSafe: false,
    });
    expect(legacySandboxRegistryInspectionToHealthFinding(shardedFile)).toEqual(
      expect.objectContaining({
        path: "/tmp/openclaw/sandbox/containers",
        message: expect.stringContaining(
          "- containers sharded: /tmp/openclaw/sandbox/containers (2 entries)",
        ),
      }),
    );
    expect(legacySandboxRegistryInspectionToRepairEffect(shardedFile)).toEqual(
      expect.objectContaining({
        target: "/tmp/openclaw/sandbox/containers",
      }),
    );
  });

  it("maps invalid legacy registry files to quarantine effects", () => {
    expect(
      legacySandboxRegistryInspectionToRepairEffect({
        kind: "browsers",
        path: "/tmp/openclaw/sandbox/browsers.json",
        source: "monolithic",
        exists: true,
        valid: false,
        entries: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        action: "would-quarantine-legacy-sandbox-registry",
        target: "/tmp/openclaw/sandbox/browsers.json",
      }),
    );
  });

  it("maps empty legacy registry files to removal effects", () => {
    expect(
      legacySandboxRegistryInspectionToRepairEffect({
        kind: "containers",
        path: "/tmp/openclaw/sandbox/containers.json",
        source: "monolithic",
        exists: true,
        valid: true,
        entries: 0,
      }),
    ).toEqual(
      expect.objectContaining({
        action: "would-remove-empty-legacy-sandbox-registry",
        target: "/tmp/openclaw/sandbox/containers.json",
      }),
    );
  });
});
