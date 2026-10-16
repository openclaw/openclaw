import { CANCEL_SYMBOL } from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxBrowserInfo, SandboxContainerInfo } from "../agents/sandbox.js";

const mocks = vi.hoisted(() => ({
  listSandboxContainers: vi.fn(),
  listSandboxBrowsers: vi.fn(),
  removeSandboxContainer: vi.fn(),
  removeSandboxBrowserContainer: vi.fn(),
}));
const { clackConfirm } = vi.hoisted(() => ({ clackConfirm: vi.fn() }));
// mock-isolation: CLI decisions must not inspect or mutate real sandbox containers.
vi.mock("../agents/sandbox.js", () => mocks);

vi.mock("../cli/local-state-owner.js", () => ({
  runWithLocalStateOwner: async ({
    runLocal,
  }: {
    runLocal: (scope: { assertCurrent: () => void }) => Promise<void>;
  }) => runLocal({ assertCurrent: () => {} }),
}));

vi.mock("@clack/prompts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@clack/prompts")>()),
  confirm: clackConfirm,
}));

import { sandboxListCommand, sandboxRecreateCommand } from "./sandbox.js";

const runtimeFields = {
  sessionKey: "test-session",
  imageMatch: true,
  running: true,
  createdAtMs: 1,
  lastUsedAtMs: 2,
};

function createContainer(overrides: Partial<SandboxContainerInfo> = {}): SandboxContainerInfo {
  const containerName = overrides.containerName ?? "openclaw-sandbox-test";
  return {
    containerName,
    backendId: "docker",
    runtimeLabel: containerName,
    image: "openclaw/sandbox:latest",
    configLabelKind: "Image",
    ...runtimeFields,
    ...overrides,
  };
}

function createBrowser(overrides: Partial<SandboxBrowserInfo> = {}): SandboxBrowserInfo {
  return {
    containerName: "openclaw-browser-test",
    image: "openclaw/browser:latest",
    ...runtimeFields,
    cdpPort: 9222,
    noVncPort: 5900,
    ...overrides,
  };
}

const runtime = { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.listSandboxContainers.mockResolvedValue([]);
  mocks.listSandboxBrowsers.mockResolvedValue([]);
  clackConfirm.mockResolvedValue(true);
});

function expectOutput(kind: "log" | "error", ...texts: string[]) {
  const output = runtime[kind].mock.calls.map(([message]) => String(message)).join("\n");
  for (const text of texts) {
    expect(output).toContain(text);
  }
  return output;
}

function list(options: Partial<Parameters<typeof sandboxListCommand>[0]> = {}) {
  return sandboxListCommand({ browser: false, json: false, ...options }, runtime);
}

function recreate(options: Partial<Parameters<typeof sandboxRecreateCommand>[0]>) {
  return sandboxRecreateCommand({ all: false, browser: false, force: false, ...options }, runtime);
}

describe("sandboxListCommand", () => {
  it("should display containers", async () => {
    const running = createContainer({ containerName: "container-1" });
    const stopped = createContainer({
      containerName: "stopped",
      imageMatch: false,
      running: false,
    });
    mocks.listSandboxContainers.mockResolvedValue([running, stopped]);

    await list();

    expectOutput("log", "📦 Sandbox Runtimes", running.containerName, stopped.containerName);
    expect(runtime.log).toHaveBeenCalledWith("    Status:  🟢 running");
    expect(runtime.log).toHaveBeenCalledWith("    Image:   openclaw/sandbox:latest ✓");
    expect(runtime.log).toHaveBeenCalledWith("    Status:  ⚫ stopped");
    expect(runtime.log).toHaveBeenCalledWith("    Image:   openclaw/sandbox:latest ⚠️  mismatch");
    expect(runtime.log).toHaveBeenCalledWith("Total: 2 (1 running)");
  });

  it.each([true, false])("renders browser imageMatch=%s", async (imageMatch) => {
    const browser = createBrowser({ containerName: "browser-1", imageMatch });
    mocks.listSandboxContainers.mockResolvedValue([createContainer({ imageMatch: false })]);
    mocks.listSandboxBrowsers.mockResolvedValue([browser]);

    await list({ browser: true });

    expectOutput(
      "log",
      "🌐 Sandbox Browser Containers",
      browser.containerName,
      String(browser.cdpPort),
    );
    if (!imageMatch) {
      expectOutput(
        "log",
        "1 runtime(s) with config mismatch detected.",
        "sandbox recreate --all --browser' to update all runtimes.",
      );
    }
    expect(runtime.log).toHaveBeenCalledWith("Total: 1 (1 running)");
  });

  it("should display message when no containers found", async () => {
    await list();

    expect(runtime.log).toHaveBeenCalledWith("No sandbox runtimes found.");
  });
  it("preserves the container JSON report", async () => {
    const container = createContainer({ imageMatch: false });
    const browserContainer = createBrowser({ imageMatch: false });
    mocks.listSandboxContainers.mockResolvedValue([container]);
    mocks.listSandboxBrowsers.mockResolvedValue([browserContainer]);

    await list({ json: true });

    expect(runtime.log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(runtime.log.mock.calls[0]?.[0]);
    expect(parsed).toStrictEqual({ containers: [container], browsers: [] });
  });
});

describe("sandboxRecreateCommand", () => {
  const scopes = [
    { browser: false, command: "sandbox list" },
    { browser: true, command: "sandbox list --browser" },
  ];
  it.each([
    ...scopes.map(({ browser, command }) => ({
      options: { browser },
      message: "Choose the sandbox scope: --all, --session <key>, or --agent <id>",
      advice: `${command} to inspect active runtimes first.`,
    })),
    {
      options: { all: true, session: "test" },
      message: "Choose only one sandbox scope: --all, --session, or --agent.",
      advice: undefined,
    },
  ])("rejects invalid scopes: $options", async ({ options, message, advice }) => {
    await recreate(options);
    expectOutput("error", message);
    if (advice) {
      expectOutput("error", advice);
    }
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.listSandboxContainers).not.toHaveBeenCalled();
    expect(mocks.listSandboxBrowsers).not.toHaveBeenCalled();
  });
  it.each([
    {
      filter: { session: "target-session" },
      keys: ["target-session", "other-session"],
      removed: ["target-session"],
      force: false,
    },
    {
      filter: { agent: "work" },
      keys: ["agent:work", "agent:work:subtask", "test-session"],
      removed: ["agent:work", "agent:work:subtask"],
      force: true,
    },
  ])("filters $filter with force=$force", async ({ filter, keys, removed, force }) => {
    const containers = keys.map((sessionKey) =>
      createContainer({ sessionKey, containerName: sessionKey }),
    );
    mocks.listSandboxContainers.mockImplementation(async (matches) => containers.filter(matches));
    await recreate({ ...filter, force });
    expect(mocks.removeSandboxContainer.mock.calls).toEqual(removed.map((name) => [name]));
    expect(clackConfirm).toHaveBeenCalledTimes(force ? 0 : 1);
    expect(mocks.listSandboxBrowsers).not.toHaveBeenCalled();
  });

  it("should remove all when --all flag set", async () => {
    const containers = [
      createContainer({ containerName: "running-container" }),
      createContainer({ containerName: "stopped-container", running: false }),
    ];
    mocks.listSandboxContainers.mockResolvedValue(containers);

    await recreate({ all: true, force: true });

    expect(runtime.log).toHaveBeenCalledWith("  - running-container [docker] (running)");
    expect(runtime.log).toHaveBeenCalledWith("  - stopped-container [docker] (stopped)");
    expect(mocks.removeSandboxContainer).toHaveBeenCalledTimes(2);
    expect(clackConfirm).not.toHaveBeenCalled();
    expectOutput("log", "✓ Removed", "2 removed, 0 failed", "automatically recreated");
  });

  it("should cancel on clack cancel symbol", async () => {
    mocks.listSandboxContainers.mockResolvedValue([createContainer()]);
    clackConfirm.mockResolvedValue(CANCEL_SYMBOL);
    await recreate({ all: true });

    expect(runtime.log).toHaveBeenCalledWith("Cancelled.");
    expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
  });
  it.each(scopes)("preserves browser=$browser in no-match advice", async ({ browser, command }) => {
    await recreate({ all: true, browser });

    expectOutput(
      "log",
      "No sandbox runtimes found matching the criteria.",
      `${command} to inspect active runtimes.`,
    );
    expect(clackConfirm).not.toHaveBeenCalled();
    expect(mocks.removeSandboxContainer).not.toHaveBeenCalled();
    expect(mocks.removeSandboxBrowserContainer).not.toHaveBeenCalled();
  });

  it.each(scopes)("reports $browser removal failures", async ({ browser, command }) => {
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

    await recreate({ all: true, browser, force: true });

    const errorOutput = expectOutput(
      "error",
      "Failed to remove failure: Removal failed.",
      `${command} to inspect what remains.`,
    );
    expect(errorOutput.match(/to inspect what remains\./gu)).toHaveLength(1);
    expectOutput("log", "1 removed, 1 failed");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
