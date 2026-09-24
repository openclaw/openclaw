// Sandbox command tests cover browser/container status formatting and sandbox diagnostics.
import { CANCEL_SYMBOL } from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxBrowserInfo, SandboxContainerInfo } from "../agents/sandbox.js";

// --- Mocks ---

const mocks = vi.hoisted(() => ({
  listSandboxContainers: vi.fn(),
  listSandboxBrowsers: vi.fn(),
  removeSandboxContainer: vi.fn(),
  removeSandboxBrowserContainer: vi.fn(),
  clackConfirm: vi.fn(),
}));

vi.mock("../agents/sandbox.js", () => ({
  listSandboxContainers: mocks.listSandboxContainers,
  listSandboxBrowsers: mocks.listSandboxBrowsers,
  removeSandboxContainer: mocks.removeSandboxContainer,
  removeSandboxBrowserContainer: mocks.removeSandboxBrowserContainer,
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: mocks.clackConfirm,
}));

import { sandboxListCommand, sandboxRecreateCommand } from "./sandbox.js";

// --- Test Factories ---

const NOW = Date.now();

function createContainer(overrides: Partial<SandboxContainerInfo> = {}): SandboxContainerInfo {
  const containerName = overrides.containerName ?? "openclaw-sandbox-test";
  return {
    containerName,
    backendId: "docker",
    runtimeLabel: containerName,
    sessionKey: "test-session",
    image: "openclaw/sandbox:latest",
    configLabelKind: "Image",
    imageMatch: true,
    running: true,
    createdAtMs: NOW - 3600000,
    lastUsedAtMs: NOW - 600000,
    ...overrides,
  };
}

function createBrowser(overrides: Partial<SandboxBrowserInfo> = {}): SandboxBrowserInfo {
  return {
    containerName: "openclaw-browser-test",
    sessionKey: "test-session",
    image: "openclaw/browser:latest",
    imageMatch: true,
    running: true,
    createdAtMs: NOW - 3600000,
    lastUsedAtMs: NOW - 600000,
    cdpPort: 9222,
    noVncPort: 5900,
    ...overrides,
  };
}

// --- Test Helpers ---

function createMockRuntime() {
  return {
    log: vi.fn(),
    error: vi.fn(),
    exit: vi.fn(),
  };
}

function setupDefaultMocks() {
  mocks.listSandboxContainers.mockResolvedValue([]);
  mocks.listSandboxBrowsers.mockResolvedValue([]);
  mocks.removeSandboxContainer.mockResolvedValue(undefined);
  mocks.removeSandboxBrowserContainer.mockResolvedValue(undefined);
  mocks.clackConfirm.mockResolvedValue(true);
}

function expectLogContains(runtime: ReturnType<typeof createMockRuntime>, text: string) {
  const loggedOutput = runtime.log.mock.calls.map(([message]) => String(message)).join("\n");
  expect(loggedOutput).toContain(text);
}

function expectErrorContains(runtime: ReturnType<typeof createMockRuntime>, text: string) {
  const errorOutput = runtime.error.mock.calls.map(([message]) => String(message)).join("\n");
  expect(errorOutput).toContain(text);
}

// --- Tests ---

describe("sandboxListCommand", () => {
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    runtime = createMockRuntime();
  });

  describe("human format output", () => {
    it("should display containers", async () => {
      const container1 = createContainer({ containerName: "container-1" });
      const container2 = createContainer({
        containerName: "container-2",
        imageMatch: false,
        running: false,
      });
      mocks.listSandboxContainers.mockResolvedValue([container1, container2]);

      await sandboxListCommand({ browser: false, json: false }, runtime as never);

      expectLogContains(runtime, "📦 Sandbox Runtimes");
      expectLogContains(runtime, container1.containerName);
      expectLogContains(runtime, container2.containerName);
      expect(runtime.log).toHaveBeenCalledWith("    Status:  🟢 running");
      expect(runtime.log).toHaveBeenCalledWith("    Image:   openclaw/sandbox:latest ✓");
      expect(runtime.log).toHaveBeenCalledWith("    Status:  ⚫ stopped");
      expect(runtime.log).toHaveBeenCalledWith("    Image:   openclaw/sandbox:latest ⚠️  mismatch");
      expect(runtime.log).toHaveBeenCalledWith("Total: 2 (1 running)");
    });

    it("should display browsers when --browser flag is set", async () => {
      const browser = createBrowser({ containerName: "browser-1" });
      mocks.listSandboxBrowsers.mockResolvedValue([browser]);

      await sandboxListCommand({ browser: true, json: false }, runtime as never);

      expectLogContains(runtime, "🌐 Sandbox Browser Containers");
      expectLogContains(runtime, browser.containerName);
      expectLogContains(runtime, String(browser.cdpPort));
    });

    it.each([
      { browser: false, command: "sandbox recreate --all" },
      { browser: true, command: "sandbox recreate --all --browser" },
    ])("preserves browser=$browser in the repair command", async ({ browser, command }) => {
      mocks.listSandboxContainers.mockResolvedValue([createContainer({ imageMatch: false })]);
      mocks.listSandboxBrowsers.mockResolvedValue([createBrowser({ imageMatch: false })]);

      await sandboxListCommand({ browser, json: false }, runtime as never);

      expectLogContains(runtime, "1 runtime(s) with config mismatch detected.");
      expectLogContains(runtime, `${command}' to update all runtimes.`);
      expect(runtime.log).toHaveBeenCalledWith("Total: 1 (1 running)");
    });

    it("should display message when no containers found", async () => {
      await sandboxListCommand({ browser: false, json: false }, runtime as never);

      expect(runtime.log).toHaveBeenCalledWith("No sandbox runtimes found.");
    });
  });

  describe("JSON output", () => {
    it.each([false, true])("preserves the browser=%s JSON report", async (browser) => {
      const container = createContainer({ imageMatch: false });
      const browserContainer = createBrowser({ imageMatch: false });
      mocks.listSandboxContainers.mockResolvedValue([container]);
      mocks.listSandboxBrowsers.mockResolvedValue([browserContainer]);

      await sandboxListCommand({ browser, json: true }, runtime as never);

      expect(runtime.log).toHaveBeenCalledTimes(1);
      const parsed = JSON.parse(runtime.log.mock.calls[0]?.[0]);
      expect(parsed).toStrictEqual({
        containers: browser ? [] : [container],
        browsers: browser ? [browserContainer] : [],
      });
    });
  });

  describe("error handling", () => {
    it("propagates backend probe failures instead of rendering an empty list", async () => {
      mocks.listSandboxContainers.mockRejectedValue(new Error("Docker not available"));

      // A failing probe must reach the CLI error path (message + exit 1),
      // not masquerade as "No sandbox runtimes found."
      await expect(
        sandboxListCommand({ browser: false, json: false }, runtime as never),
      ).rejects.toThrow("Docker not available");
      expect(runtime.log).not.toHaveBeenCalledWith("No sandbox runtimes found.");
    });
  });
});

describe("sandboxRecreateCommand", () => {
  const scopes = [
    { browser: false, command: "sandbox list" },
    { browser: true, command: "sandbox list --browser" },
  ];
  let runtime: ReturnType<typeof createMockRuntime>;

  beforeEach(() => {
    vi.clearAllMocks();
    setupDefaultMocks();
    runtime = createMockRuntime();
  });

  describe("validation", () => {
    it.each(scopes)(
      "preserves browser=$browser in missing-scope advice",
      async ({ browser, command }) => {
        await sandboxRecreateCommand({ all: false, browser, force: false }, runtime as never);

        expectErrorContains(
          runtime,
          "Choose the sandbox scope: --all, --session <key>, or --agent <id>",
        );
        expectErrorContains(runtime, `${command} to inspect active runtimes first.`);
        expect(runtime.exit).toHaveBeenCalledWith(1);
        expect(mocks.listSandboxContainers).not.toHaveBeenCalled();
        expect(mocks.listSandboxBrowsers).not.toHaveBeenCalled();
      },
    );

    it("should error if multiple filters specified", async () => {
      await sandboxRecreateCommand(
        { all: true, session: "test", browser: false, force: false },
        runtime as never,
      );

      expectErrorContains(runtime, "Choose only one sandbox scope: --all, --session, or --agent.");
      expect(runtime.exit).toHaveBeenCalledWith(1);
      expect(mocks.listSandboxContainers).not.toHaveBeenCalled();
      expect(mocks.listSandboxBrowsers).not.toHaveBeenCalled();
    });
  });

  describe("filtering", () => {
    it("should filter by session", async () => {
      const match = createContainer({ sessionKey: "target-session" });
      const noMatch = createContainer({ sessionKey: "other-session" });
      mocks.listSandboxContainers.mockResolvedValue([match, noMatch]);

      await sandboxRecreateCommand(
        { session: "target-session", all: false, browser: false, force: true },
        runtime as never,
      );

      expect(mocks.removeSandboxContainer).toHaveBeenCalledTimes(1);
      expect(mocks.removeSandboxContainer).toHaveBeenCalledWith(match.containerName);
    });

    it("should filter by agent (exact + subkeys)", async () => {
      const agent = createContainer({ sessionKey: "agent:work" });
      const agentSub = createContainer({ sessionKey: "agent:work:subtask" });
      const other = createContainer({ sessionKey: "test-session" });
      mocks.listSandboxContainers.mockResolvedValue([agent, agentSub, other]);

      await sandboxRecreateCommand(
        { agent: "work", all: false, browser: false, force: true },
        runtime as never,
      );

      expect(mocks.removeSandboxContainer).toHaveBeenCalledTimes(2);
      expect(mocks.removeSandboxContainer).toHaveBeenCalledWith(agent.containerName);
      expect(mocks.removeSandboxContainer).toHaveBeenCalledWith(agentSub.containerName);
    });

    it("should remove all when --all flag set", async () => {
      const containers = [
        createContainer({ containerName: "running-container" }),
        createContainer({ containerName: "stopped-container", running: false }),
      ];
      mocks.listSandboxContainers.mockResolvedValue(containers);

      await sandboxRecreateCommand({ all: true, browser: false, force: true }, runtime as never);

      expect(runtime.log).toHaveBeenCalledWith("  - running-container [docker] (running)");
      expect(runtime.log).toHaveBeenCalledWith("  - stopped-container [docker] (stopped)");
      expect(mocks.removeSandboxContainer).toHaveBeenCalledTimes(2);
    });

    it("should handle browsers when --browser flag set", async () => {
      const browsers = [createBrowser(), createBrowser()];
      mocks.listSandboxBrowsers.mockResolvedValue(browsers);

      await sandboxRecreateCommand({ all: true, browser: true, force: true }, runtime as never);

      expect(mocks.removeSandboxBrowserContainer).toHaveBeenCalledTimes(2);
      expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
    });
  });

  describe("confirmation flow", () => {
    async function runCancelledConfirmation(confirmResult: boolean | symbol) {
      mocks.listSandboxContainers.mockResolvedValue([createContainer()]);
      mocks.clackConfirm.mockResolvedValue(confirmResult);

      await sandboxRecreateCommand({ all: true, browser: false, force: false }, runtime as never);
    }

    it("should require confirmation without --force", async () => {
      mocks.listSandboxContainers.mockResolvedValue([createContainer()]);
      mocks.clackConfirm.mockResolvedValue(true);

      await sandboxRecreateCommand({ all: true, browser: false, force: false }, runtime as never);

      expect(mocks.clackConfirm).toHaveBeenCalled();
      expect(mocks.removeSandboxContainer).toHaveBeenCalled();
    });

    it("should cancel when user declines", async () => {
      await runCancelledConfirmation(false);

      expect(runtime.log).toHaveBeenCalledWith("Cancelled.");
      expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
    });

    it("should cancel on clack cancel symbol", async () => {
      await runCancelledConfirmation(CANCEL_SYMBOL);

      expect(runtime.log).toHaveBeenCalledWith("Cancelled.");
      expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
    });

    it("should skip confirmation with --force", async () => {
      mocks.listSandboxContainers.mockResolvedValue([createContainer()]);

      await sandboxRecreateCommand({ all: true, browser: false, force: true }, runtime as never);

      expect(mocks.clackConfirm).not.toHaveBeenCalled();
      expect(mocks.removeSandboxContainer).toHaveBeenCalled();
    });
  });

  describe("execution", () => {
    it.each(scopes)(
      "preserves browser=$browser in no-match advice",
      async ({ browser, command }) => {
        await sandboxRecreateCommand({ all: true, browser, force: false }, runtime as never);

        expectLogContains(runtime, "No sandbox runtimes found matching the criteria.");
        expectLogContains(runtime, `${command} to inspect active runtimes.`);
        expect(mocks.clackConfirm).not.toHaveBeenCalled();
        expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
        expect(mocks.removeSandboxBrowserContainer).not.toHaveBeenCalled();
      },
    );

    it.each(scopes)(
      "preserves browser=$browser in removal-failure advice",
      async ({ browser, command }) => {
        mocks.listSandboxContainers.mockResolvedValue([
          createContainer({ containerName: "success" }),
          createContainer({ containerName: "failure" }),
        ]);
        mocks.listSandboxBrowsers.mockResolvedValue([
          createBrowser({ containerName: "success" }),
          createBrowser({ containerName: "failure" }),
        ]);
        const remove = browser ? mocks.removeSandboxBrowserContainer : mocks.removeSandboxContainer;
        remove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Removal failed"));

        await sandboxRecreateCommand({ all: true, browser, force: true }, runtime as never);

        expectErrorContains(runtime, "Failed to remove failure: Removal failed.");
        expectErrorContains(runtime, `${command} to inspect what remains.`);
        expect(
          runtime.error.mock.calls.filter(([message]) =>
            String(message).includes("to inspect what remains."),
          ),
        ).toHaveLength(1);
        expectLogContains(runtime, "1 removed, 1 failed");
        expect(runtime.exit).toHaveBeenCalledWith(1);
      },
    );

    it("should display success message", async () => {
      mocks.listSandboxContainers.mockResolvedValue([createContainer()]);

      await sandboxRecreateCommand({ all: true, browser: false, force: true }, runtime as never);

      expectLogContains(runtime, "✓ Removed");
      expectLogContains(runtime, "1 removed, 0 failed");
      expectLogContains(runtime, "automatically recreated");
    });
  });
});
