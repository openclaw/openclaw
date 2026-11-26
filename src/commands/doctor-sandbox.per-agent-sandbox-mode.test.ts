import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SANDBOX_IMAGE } from "../agents/sandbox/constants.js";
import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import { withMockedPlatform as onPlatform } from "../test-utils/vitest-spies.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const runExec = vi.fn();
const runCommandWithTimeout = vi.fn<typeof import("../process/exec.js").runCommandWithTimeout>();
const note = vi.fn();
const validateSandboxContainerEngineTarget = vi.fn();
const resolveCodexHealthApi = vi.fn();
const probeCodexWorkspaceWriteSandbox = vi.fn();

// mock-isolation: Doctor receives a synthetic health API without loading bundled runtimes.
vi.mock("../flows/bundled-health-checks.js", () => ({ resolveCodexHealthApi }));

// mock-isolation: Sandbox probes must not launch commands on the test host.
vi.mock("../process/exec.js", () => ({ runExec, runCommandWithTimeout }));

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

describe("per-agent sandbox health", () => {
  const mockRuntime: RuntimeEnv = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };

  const mockPrompter: DoctorPrompter = {
    confirmRuntimeRepair: vi.fn().mockResolvedValue(false),
  } as unknown as DoctorPrompter;

  /** Config with sandboxing enabled for the "work" agent only, by default. */
  function perAgentConfig(
    sandbox: Record<string, unknown>,
    defaultsSandbox?: Record<string, unknown>,
  ): OpenClawConfig {
    return {
      agents: {
        ...(defaultsSandbox ? { defaults: { sandbox: defaultsSandbox } } : {}),
        entries: { work: { sandbox } },
      },
    };
  }

  const expectNote = (message: string) =>
    expect(note).toHaveBeenCalledWith(expect.stringContaining(message), "Sandbox");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockPrompter.confirmRuntimeRepair).mockResolvedValue(false);
    runExec.mockResolvedValue({ stdout: "", stderr: "" });
    validateSandboxContainerEngineTarget.mockResolvedValue(undefined);
    resolveCodexHealthApi.mockReturnValue({
      status: "available",
      api: { probeCodexWorkspaceWriteSandbox },
    });
    probeCodexWorkspaceWriteSandbox.mockResolvedValue({ status: "ok" });
  });

  it("reports unavailable Docker when sandboxing is enabled per agent only", async () => {
    runExec.mockRejectedValue(new Error("Docker not installed"));

    await maybeRepairSandboxImages(perAgentConfig({ mode: "all" }), mockRuntime, mockPrompter);

    expectNote(
      'for agent "work" (agents.entries.work.sandbox, mode: "all") but Docker is not available',
    );
    expectNote("Isolated sessions (automations, sub-agents) will fail without Docker.");
    expectNote("openclaw config set agents.entries.work.sandbox.mode off");
  });

  it("checks the per-agent sandbox image when Docker is available", async () => {
    runExec.mockImplementation(async (command: string, args: string[]) => {
      if (command === "docker" && args[0] === "image") {
        throw Object.assign(new Error("missing image"), { stderr: "No such image" });
      }
      return { stdout: "", stderr: "" };
    });

    const warnings = await maybeRepairSandboxImages(
      perAgentConfig({ mode: "all", docker: { image: "custom-sandbox:1" } }),
      mockRuntime,
      mockPrompter,
    );

    expect(runExec).toHaveBeenCalledWith("docker", ["image", "inspect", "custom-sandbox:1"], {
      timeoutMs: 5_000,
    });
    expect(warnings).toEqual([
      expect.stringContaining("Sandbox base image missing: custom-sandbox:1"),
    ]);
  });

  it("checks list-roster agents too", async () => {
    runExec.mockRejectedValue(new Error("Docker not installed"));
    // Legacy array roster shape: the typed config only carries `entries`, but the runtime roster
    // reader still accepts `agents.list`.
    const cfg = {
      agents: { list: [{ id: "work", sandbox: { mode: "all" } }] },
    } as unknown as OpenClawConfig;

    await maybeRepairSandboxImages(cfg, mockRuntime, mockPrompter);

    expectNote('for agent "work" (agents.list (id "work")');
  });

  it("skips agents whose resolved sandbox mode is off", async () => {
    await maybeRepairSandboxImages(perAgentConfig({ mode: "off" }), mockRuntime, mockPrompter);
    await maybeRepairSandboxImages(
      perAgentConfig({ docker: { image: "agent-image:1" } }),
      mockRuntime,
      mockPrompter,
    );
    await maybeRepairSandboxImages(
      perAgentConfig({ mode: "off" }, { mode: "off" }),
      mockRuntime,
      mockPrompter,
    );

    expect(runExec).not.toHaveBeenCalled();
    expect(note).not.toHaveBeenCalled();
  });

  it("checks both the defaults and the inherited per-agent image", async () => {
    await maybeRepairSandboxImages(
      perAgentConfig(
        { docker: { image: "agent-image:1" } },
        { mode: "all", docker: { image: "default-image:1" } },
      ),
      mockRuntime,
      mockPrompter,
    );

    expect(runExec).toHaveBeenCalledWith("docker", ["image", "inspect", "default-image:1"], {
      timeoutMs: 5_000,
    });
    expect(runExec).toHaveBeenCalledWith("docker", ["image", "inspect", "agent-image:1"], {
      timeoutMs: 5_000,
    });
  });

  it("keeps an explicitly empty per-agent image instead of probing the default", async () => {
    // The runtime's nullish image selection preserves "" and passes it to container creation,
    // so doctor must not inspect (or offer to build) the unrelated default image here.
    const warnings = await maybeRepairSandboxImages(
      perAgentConfig({ mode: "all", docker: { image: "" } }),
      mockRuntime,
      mockPrompter,
    );

    expect(runExec).not.toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", DEFAULT_SANDBOX_IMAGE],
      expect.anything(),
    );
    expect(mockPrompter.confirmRuntimeRepair).not.toHaveBeenCalled();
    expect(warnings).toEqual([
      expect.stringContaining(
        "Sandbox base image resolves to an empty string (agents.entries.work.sandbox)",
      ),
    ]);
  });

  it("resolves shared-scope agents through the runtime owner, ignoring agent docker overrides", async () => {
    await maybeRepairSandboxImages(
      perAgentConfig(
        { mode: "all", scope: "shared", docker: { image: "agent-image:1" } },
        { docker: { image: "default-image:1" } },
      ),
      mockRuntime,
      mockPrompter,
    );

    expect(runExec).toHaveBeenCalledWith("docker", ["image", "inspect", "default-image:1"], {
      timeoutMs: 5_000,
    });
    expect(runExec).not.toHaveBeenCalledWith(
      "docker",
      ["image", "inspect", "agent-image:1"],
      expect.anything(),
    );
  });

  it("notes Codex bwrap namespace failures for per-agent sandboxing", async () => {
    runExec.mockImplementation(async (command: string) => {
      if (command === "unshare") {
        throw Object.assign(new Error("unshare failed"), {
          stderr: "unshare: write failed /proc/self/uid_map: Operation not permitted",
        });
      }
      return { stdout: "", stderr: "" };
    });

    await onPlatform("linux", () =>
      noteCodexBwrapNamespaceWarnings(perAgentConfig({ mode: "all" })),
    );

    expectNote("Codex bwrap user namespace check failed");
  });
});
