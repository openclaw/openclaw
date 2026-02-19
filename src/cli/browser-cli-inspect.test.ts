import { Command } from "commander";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const gatewayMocks = vi.hoisted(() => ({
  callGatewayFromCli: vi.fn(async () => ({
    ok: true,
    format: "ai",
    targetId: "t1",
    url: "https://example.com",
    snapshot: "ok",
  })),
}));

vi.mock("./gateway-rpc.js", () => ({
  callGatewayFromCli: gatewayMocks.callGatewayFromCli,
}));

const configMocks = vi.hoisted(() => ({
  loadConfig: vi.fn(() => ({ browser: {} })),
}));
vi.mock("../config/config.js", () => configMocks);

const sharedMocks = vi.hoisted(() => ({
  callBrowserRequest: vi.fn(
    async (_opts: unknown, params: { path?: string; query?: Record<string, unknown> }) => {
      const format = params.query?.format === "aria" ? "aria" : "ai";
      if (format === "aria") {
        return {
          ok: true,
          format: "aria",
          targetId: "t1",
          url: "https://example.com",
          nodes: [],
        };
      }
      return {
        ok: true,
        format: "ai",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      };
    },
  ),
}));
vi.mock("./browser-cli-shared.js", () => ({
  callBrowserRequest: sharedMocks.callBrowserRequest,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};
vi.mock("../runtime.js", () => ({
  defaultRuntime: runtime,
}));

let registerBrowserInspectCommands: typeof import("./browser-cli-inspect.js").registerBrowserInspectCommands;

type SnapshotDefaultsCase = {
  label: string;
  args: string[];
  expectMode: "efficient" | undefined;
};

describe("browser cli snapshot defaults", () => {
  const runSnapshot = async (args: string[]) => {
    const program = new Command();
    const browser = program.command("browser").option("--json", "JSON output", false);
    registerBrowserInspectCommands(browser, () => ({}));
    await program.parseAsync(["browser", "snapshot", ...args], { from: "user" });

    const [, params] = sharedMocks.callBrowserRequest.mock.calls.at(-1) ?? [];
    return params as { path?: string; query?: Record<string, unknown> } | undefined;
  };

  beforeAll(async () => {
    ({ registerBrowserInspectCommands } = await import("./browser-cli-inspect.js"));
  });

  afterEach(() => {
    vi.clearAllMocks();
    configMocks.loadConfig.mockReturnValue({ browser: {} });
  });

  it.each<SnapshotDefaultsCase>([
    {
      label: "uses config snapshot defaults when mode is not provided",
      args: [],
      expectMode: "efficient",
    },
    {
      label: "does not apply config snapshot defaults to aria snapshots",
      args: ["--format", "aria"],
      expectMode: undefined,
    },
  ])("$label", async ({ args, expectMode }) => {
    configMocks.loadConfig.mockReturnValue({
      browser: { snapshotDefaults: { mode: "efficient" } },
    });

    if (args.includes("--format")) {
      gatewayMocks.callGatewayFromCli.mockResolvedValueOnce({
        ok: true,
        format: "aria",
        targetId: "t1",
        url: "https://example.com",
        snapshot: "ok",
      });
    }

    const params = await runSnapshot(args);
    expect(params?.path).toBe("/snapshot");
    if (expectMode === undefined) {
      expect((params?.query as { mode?: unknown } | undefined)?.mode).toBeUndefined();
    } else {
      expect(params?.query).toMatchObject({
        format: "ai",
        mode: expectMode,
      });
    }
  });
});
