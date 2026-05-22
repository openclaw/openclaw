import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
import type { DoctorRepairMode } from "./doctor-repair-mode.js";

const runExec = vi.fn();
const runCommandWithTimeout = vi.fn();
const note = vi.fn();
const inspectLegacySandboxRegistryFiles = vi.fn();
const migrateLegacySandboxRegistryFiles = vi.fn();

vi.mock("../process/exec.js", () => ({
  runExec,
  runCommandWithTimeout,
}));

vi.mock("../agents/sandbox.js", () => ({
  DEFAULT_SANDBOX_BROWSER_IMAGE: "browser-image",
  DEFAULT_SANDBOX_COMMON_IMAGE: "common-image",
  DEFAULT_SANDBOX_IMAGE: "default-image",
  isDockerDaemonUnavailable: vi.fn(() => false),
  resolveSandboxScope: vi.fn(() => "shared"),
}));

vi.mock("../agents/sandbox/registry.js", () => ({
  inspectLegacySandboxRegistryFiles,
  migrateLegacySandboxRegistryFiles,
}));

vi.mock("../terminal/note.js", () => ({
  note,
}));

const {
  collectSandboxScopeWarnings,
  detectSandboxImageIssues,
  detectSandboxRegistryFileIssues,
  maybeRepairSandboxImages,
  maybeRepairSandboxRegistryFiles,
  repairSandboxImages,
} = await import("./doctor-sandbox.js");

describe("maybeRepairSandboxImages", () => {
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
    runExec.mockReset();
    runCommandWithTimeout.mockReset();
    inspectLegacySandboxRegistryFiles.mockResolvedValue([]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([]);
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

    // The warning should clearly indicate sandbox is enabled but won't work
    expect(note).toHaveBeenCalled();
    const noteCall = firstNoteCall();
    const message = noteCall[0] as string;

    // The message should warn that sandbox mode won't function, not just "skipping checks"
    expect(message).toMatch(/sandbox.*mode.*enabled|sandbox.*won.*work|docker.*required/i);
    // Should NOT just say "skipping sandbox image checks" - that's too mild
    expect(message).not.toBe("Docker not available; skipping sandbox image checks.");
  });

  it("warns when sandbox mode is 'all' but Docker is not available", async () => {
    await runSandboxRepair({ mode: "all", dockerAvailable: false });

    expect(note).toHaveBeenCalled();
    const noteCall = firstNoteCall();
    const message = noteCall[0] as string;

    // Should warn about the impact on sandbox functionality
    expect(message).toMatch(/sandbox|docker/i);
  });

  it("does not warn when sandbox mode is off", async () => {
    await runSandboxRepair({ mode: "off", dockerAvailable: false });

    // No warning needed when sandbox is off
    expect(note).not.toHaveBeenCalled();
  });

  it("does not warn when Docker is available", async () => {
    await runSandboxRepair({ mode: "non-main", dockerAvailable: true });

    // May have other notes about images, but not the Docker unavailable warning
    const dockerUnavailableWarning = note.mock.calls.find(
      (call) =>
        typeof call[0] === "string" && call[0].toLowerCase().includes("docker not available"),
    );
    expect(dockerUnavailableWarning).toBeUndefined();
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
      await maybeRepairSandboxImages(createSandboxConfig("all"), mockRuntime, mockPrompter);
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
  });

  it("does not offer the default browser setup script for custom browser images", async () => {
    runExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "version") {
        return { stdout: "24.0.0", stderr: "" };
      }
      if (command === "unshare") {
        return { stdout: "", stderr: "" };
      }
      if (command === "docker" && args.includes("default-image")) {
        return { stdout: "base image exists", stderr: "" };
      }
      if (command === "docker" && args.includes("registry.example.com/browser:custom")) {
        throw Object.assign(new Error("missing image"), {
          stderr: "No such image: registry.example.com/browser:custom",
        });
      }
      return { stdout: "", stderr: "" };
    });

    await maybeRepairSandboxImages(
      {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              browser: {
                enabled: true,
                image: "registry.example.com/browser:custom",
              },
            },
          },
        },
      },
      mockRuntime,
      mockPrompter,
    );

    expect(mockPrompter.confirmRuntimeRepair).not.toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Build browser sandbox image now?",
      }),
    );
    expect(note).toHaveBeenCalledWith(
      "Sandbox browser image missing: registry.example.com/browser:custom. Build or pull it first.",
      "Sandbox",
    );
  });

  it("checks Codex bwrap network namespaces only when Docker sandbox egress is offline", async () => {
    const platformSpy = vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    runExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "version") {
        return { stdout: "24.0.0", stderr: "" };
      }
      if (command === "unshare") {
        if (args.includes("--net")) {
          throw Object.assign(new Error("unshare failed"), {
            stderr: "unshare: unshare failed: Operation not permitted",
          });
        }
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    try {
      await maybeRepairSandboxImages(createSandboxConfig("all"), mockRuntime, mockPrompter);
    } finally {
      platformSpy.mockRestore();
    }

    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("Codex bwrap network namespace probe failed"),
      "Sandbox",
    );
    expect(note).toHaveBeenCalledWith(
      expect.stringContaining("bwrap: loopback: Failed RTM_NEWADDR"),
      "Sandbox",
    );
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
      await maybeRepairSandboxImages(
        createSandboxConfigWithDockerNetwork("bridge"),
        mockRuntime,
        mockPrompter,
      );
    } finally {
      platformSpy.mockRestore();
    }

    expect(
      runExec.mock.calls.some(
        ([command, args]) => command === "unshare" && Array.isArray(args) && args.includes("--net"),
      ),
    ).toBe(false);
  });

  it("detects Codex bwrap namespace failures as structured sandbox issues", async () => {
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
      if (command === "docker") {
        return { stdout: "image exists", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });

    try {
      await expect(detectSandboxImageIssues(createSandboxConfig("all"))).resolves.toContainEqual(
        expect.objectContaining({
          kind: "codex-bwrap-namespace-unavailable",
          message: expect.stringContaining("Codex bwrap user namespace probe failed"),
          fixHint: expect.stringContaining("kernel.apparmor_restrict_unprivileged_userns=0"),
        }),
      );
    } finally {
      platformSpy.mockRestore();
    }
  });

  it("detects Docker unavailable as a structured sandbox image issue", async () => {
    runExec.mockRejectedValue(new Error("Docker not installed"));

    await expect(detectSandboxImageIssues(createSandboxConfig("non-main"))).resolves.toContainEqual(
      expect.objectContaining({
        kind: "docker-unavailable",
        path: "agents.defaults.sandbox.mode",
        message: expect.stringContaining("Docker is not available"),
      }),
    );
  });

  it("detects missing base and browser sandbox images", async () => {
    runExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "version") {
        return { stdout: "24.0.0", stderr: "" };
      }
      if (command === "unshare") {
        return { stdout: "", stderr: "" };
      }
      if (command === "docker" && args.includes("default-image")) {
        throw { stderr: "No such image: default-image" };
      }
      if (command === "docker" && args.includes("browser-image")) {
        throw { stderr: "No such image: browser-image" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      detectSandboxImageIssues({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              browser: { enabled: true },
            },
          },
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "missing-image",
        imageKind: "base",
        image: "default-image",
        path: "agents.defaults.sandbox.docker.image",
        buildScript: "scripts/sandbox-setup.sh",
      }),
      expect.objectContaining({
        kind: "missing-image",
        imageKind: "browser",
        image: "browser-image",
        path: "agents.defaults.sandbox.browser.image",
        buildScript: "scripts/sandbox-browser-setup.sh",
      }),
    ]);
  });

  it("leaves custom browser sandbox images operator-managed", async () => {
    runExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "version") {
        return { stdout: "24.0.0", stderr: "" };
      }
      if (command === "unshare") {
        return { stdout: "", stderr: "" };
      }
      if (command === "docker" && args.includes("default-image")) {
        return { stdout: "base image exists", stderr: "" };
      }
      if (command === "docker" && args.includes("registry.example.com/browser:custom")) {
        throw { stderr: "No such image: registry.example.com/browser:custom" };
      }
      return { stdout: "", stderr: "" };
    });

    await expect(
      detectSandboxImageIssues({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              browser: {
                enabled: true,
                image: "registry.example.com/browser:custom",
              },
            },
          },
        },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        kind: "missing-image",
        imageKind: "browser",
        image: "registry.example.com/browser:custom",
        path: "agents.defaults.sandbox.browser.image",
        buildScript: undefined,
      }),
    ]);
  });

  it("routes structured sandbox repair guidance through repair notes", async () => {
    const repairNote = vi.fn();
    const prompter = {
      ...mockPrompter,
      note: repairNote,
    };
    runExec
      .mockResolvedValueOnce({ stdout: "24.0.0", stderr: "" })
      .mockRejectedValueOnce({ stderr: "No such image: registry.example.com/sandbox:custom" });

    const result = await repairSandboxImages({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              docker: {
                image: "registry.example.com/sandbox:custom",
              },
            },
          },
        },
      },
      runtime: mockRuntime,
      prompter,
      issues: [
        {
          kind: "missing-image",
          imageKind: "base",
          image: "registry.example.com/sandbox:custom",
          path: "agents.defaults.sandbox.docker.image",
          message: "Sandbox base image missing: registry.example.com/sandbox:custom.",
          fixHint: "Build or pull it first.",
        },
      ],
    });

    expect(note).not.toHaveBeenCalled();
    expect(repairNote).toHaveBeenCalledWith(
      "Sandbox base image missing: registry.example.com/sandbox:custom. Build or pull it first.",
      "Sandbox",
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: "skipped",
        reason: "sandbox image repair did not build an image",
        changes: [],
      }),
    );
  });

  it("reports attempted sandbox image build failures as failed repairs", async () => {
    const prompter = {
      ...mockPrompter,
      confirmRuntimeRepair: vi.fn().mockResolvedValue(true),
    };
    runExec
      .mockResolvedValueOnce({ stdout: "24.0.0", stderr: "" })
      .mockRejectedValueOnce({ stderr: "No such image: registry.example.com/sandbox:custom" });
    runCommandWithTimeout.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr: "build failed",
    });

    const result = await repairSandboxImages({
      cfg: {
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              docker: {
                image: "registry.example.com/sandbox:custom",
              },
            },
          },
        },
      },
      runtime: mockRuntime,
      prompter,
      issues: [
        {
          kind: "missing-image",
          imageKind: "base",
          image: "registry.example.com/sandbox:custom",
          path: "agents.defaults.sandbox.docker.image",
          buildScript: "package.json",
          message: "Sandbox base image missing: registry.example.com/sandbox:custom.",
          fixHint: "Build it with package.json.",
        },
      ],
    });

    expect(result).toEqual(
      expect.objectContaining({
        status: "failed",
        reason: "sandbox image repair failed to build an image",
        changes: [],
        warnings: ["Failed to build sandbox base image registry.example.com/sandbox:custom."],
      }),
    );
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
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
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
        "- containers: /tmp/openclaw/sandbox/containers.json (2 entries)",
        "Run openclaw doctor --fix to migrate them to sharded registry files.",
      ].join("\n"),
      "Sandbox",
    );
  });

  it("detects legacy registry files for structured lint", async () => {
    inspectLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
        exists: true,
        valid: true,
        entries: 2,
      },
      {
        kind: "browsers",
        registryPath: "/tmp/openclaw/sandbox/browsers.json",
        shardedDir: "/tmp/openclaw/sandbox/browsers",
        exists: false,
        valid: true,
        entries: 0,
      },
    ]);

    await expect(detectSandboxRegistryFileIssues()).resolves.toEqual([
      expect.objectContaining({
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
      }),
    ]);
  });

  it("migrates legacy registry files during doctor --fix", async () => {
    inspectLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
        exists: true,
        valid: true,
        entries: 2,
      },
    ]);
    migrateLegacySandboxRegistryFiles.mockResolvedValue([
      {
        kind: "containers",
        registryPath: "/tmp/openclaw/sandbox/containers.json",
        shardedDir: "/tmp/openclaw/sandbox/containers",
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
      "- Migrated containers registry from /tmp/openclaw/sandbox/containers.json into 2 shards.",
      "Doctor changes",
    );
  });
});

describe("collectSandboxScopeWarnings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("collects ignored per-agent sandbox overrides under shared scope", () => {
    expect(
      collectSandboxScopeWarnings({
        agents: {
          defaults: {
            sandbox: {
              mode: "all",
              scope: "shared",
            },
          },
          list: [
            {
              id: "work",
              sandbox: {
                scope: "shared",
                docker: {
                  setupCommand: "echo setup",
                },
                browser: {
                  enabled: true,
                },
              },
            },
          ],
        },
      }),
    ).toContainEqual(
      expect.objectContaining({
        agentId: "work",
        path: "agents.list.work.sandbox",
        message: 'agents.list (id "work") sandbox docker/browser overrides ignored.',
      }),
    );
  });
});
