import { CANCEL_SYMBOL } from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxBrowserInfo, SandboxContainerInfo } from "../agents/sandbox/manage.js";

const mocks = vi.hoisted(() => ({
  listSandboxContainers: vi.fn(),
  listSandboxBrowsers: vi.fn(),
  removeSandboxContainer: vi.fn(),
  removeSandboxBrowserContainer: vi.fn(),
}));
const { clackConfirm } = vi.hoisted(() => ({ clackConfirm: vi.fn() }));
// mock-isolation: CLI decisions must not inspect or mutate real sandbox containers.
vi.mock("../agents/sandbox/manage.js", () => mocks);

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
  it.each([false, true])(
    "renders runtime state and mismatch advice (browser=%s)",
    async (browser) => {
      const create = browser ? createBrowser : createContainer;
      const selected = browser ? mocks.listSandboxBrowsers : mocks.listSandboxContainers;
      selected.mockResolvedValue([
        create({ containerName: "running" }),
        create({ containerName: "stopped", imageMatch: false, running: false }),
      ]);
      await list({ browser });
      expectOutput(
        "log",
        browser ? "🌐 Sandbox Browser Containers" : "📦 Sandbox Runtimes",
        "running",
        "stopped",
        "Status:  🟢 running",
        "Status:  ⚫ stopped",
        `${browser ? "openclaw/browser" : "openclaw/sandbox"}:latest ✓`,
        `${browser ? "openclaw/browser" : "openclaw/sandbox"}:latest ⚠️  mismatch`,
        "Total: 2 (1 running)",
        "1 runtime(s) with config mismatch detected.",
        `sandbox recreate --all${browser ? " --browser" : ""}' to update all runtimes.`,
      );
      if (browser) {
        expectOutput("log", "CDP:     9222");
      }
    },
  );

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
  const missingScope = "Choose the sandbox scope: --all, --session <key>, or --agent <id>";
  const scopes = [
    { browser: false, command: "sandbox list" },
    { browser: true, command: "sandbox list --browser" },
  ];
  it.each([
    [{}, missingScope, "sandbox list to inspect active runtimes first."],
    [{ browser: true }, missingScope, "sandbox list --browser to inspect active runtimes first."],
    [
      { all: true, session: "test" },
      "Choose only one sandbox scope: --all, --session, or --agent.",
      undefined,
    ],
  ] as const)("rejects invalid scopes: %j", async (options, message, advice) => {
    await recreate(options);
    expectOutput("error", message);
    if (advice) {
      expectOutput("error", advice);
    }
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(mocks.listSandboxContainers).not.toHaveBeenCalled();
    expect(mocks.listSandboxBrowsers).not.toHaveBeenCalled();
  });
  it("selects agent descendants but excludes unrelated sessions", async () => {
    const removed = ["agent:work", "agent:work:subtask"];
    const containers = [...removed, "test-session"].map((sessionKey) =>
      createContainer({ sessionKey, containerName: sessionKey }),
    );
    mocks.listSandboxContainers.mockImplementation(async (matches) => containers.filter(matches));
    await recreate({ agent: "work", force: false });
    expect(mocks.removeSandboxContainer.mock.calls).toEqual(removed.map((name) => [name]));
    expectOutput("log", `${removed.length} removed, 0 failed`);
    expect(clackConfirm).toHaveBeenCalledOnce();
    expect(mocks.listSandboxBrowsers).not.toHaveBeenCalled();
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
      createContainer({ containerName: "failure", running: false }),
    ]);
    mocks.listSandboxBrowsers.mockResolvedValue([
      createBrowser({ containerName: "success" }),
      createBrowser({ containerName: "failure" }),
    ]);
    const remove = browser ? mocks.removeSandboxBrowserContainer : mocks.removeSandboxContainer;
    remove.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("Removal failed"));

    await recreate({ all: true, browser, force: true });

    expect(remove.mock.calls).toEqual([["success"], ["failure"]]);
    expect(clackConfirm).not.toHaveBeenCalled();
    if (!browser) {
      expect(runtime.log).toHaveBeenCalledWith("  - success [docker] (running)");
      expect(runtime.log).toHaveBeenCalledWith("  - failure [docker] (stopped)");
    }
    const errorOutput = expectOutput(
      "error",
      "Failed to remove failure: Removal failed.",
      `${command} to inspect what remains.`,
    );
    expect(errorOutput.match(/to inspect what remains\./gu)).toHaveLength(1);
    expectOutput("log", "✓ Removed", "1 removed, 1 failed", "automatically recreated");
    expect(runtime.exit).toHaveBeenCalledWith(1);
  });
});
