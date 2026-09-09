// Plugins search command tests cover plugin search command registration and results.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawHubFetch } from "../infra/clawhub-client.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const errors: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn((value: unknown) => errors.push(String(value))),
    writeJson: vi.fn((value: unknown, space = 2) =>
      logs.push(JSON.stringify(value, null, space > 0 ? space : undefined)),
    ),
    writeStdout: vi.fn((value: string) =>
      logs.push(value.endsWith("\n") ? value.slice(0, -1) : value),
    ),
    exit: vi.fn((code: number) => {
      throw new Error(`__exit__:${code}`);
    }),
  };
  return {
    logs,
    errors,
    runtime,
    fetch: vi.fn<ClawHubFetch>(),
  };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const { runPluginsSearchCommand } = await import("./plugins-search-command.js");
const { registerPluginsCli } = await import("./plugins-cli.js");

describe("plugins search command", () => {
  beforeEach(() => {
    mocks.logs.length = 0;
    mocks.errors.length = 0;
    mocks.runtime.log.mockClear();
    mocks.runtime.error.mockClear();
    mocks.runtime.writeJson.mockClear();
    mocks.runtime.exit.mockClear();
    mocks.fetch.mockReset();
    vi.stubGlobal("fetch", mocks.fetch);
    vi.stubEnv("CLAWHUB_TOKEN", "synthetic-clawhub-token");
  });

  it.each([
    {
      context: "default",
      profile: undefined,
      container: undefined,
      command: "openclaw plugins install clawhub:openclaw-calendar",
    },
    {
      context: "profile",
      profile: "work",
      container: undefined,
      command: "openclaw --profile work plugins install clawhub:openclaw-calendar",
    },
    {
      context: "container",
      profile: undefined,
      container: "staging",
      command: "openclaw --container staging plugins install clawhub:openclaw-calendar",
    },
    {
      context: "container over profile",
      profile: "work",
      container: "staging",
      command: "openclaw --container staging plugins install clawhub:openclaw-calendar",
    },
  ])("searches the combined catalog with the $context install context", async (scenario) => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({
        results: [
          {
            score: 12,
            package: {
              name: "openclaw-calendar",
              displayName: "Calendar",
              family: "code-plugin",
              channel: "community",
              isOfficial: false,
              summary: "Calendar sync",
              createdAt: 1,
              updatedAt: 1,
              latestVersion: "1.2.3",
            },
          },
          {
            score: 10,
            package: {
              name: "openclaw-calendar-bundle",
              displayName: "Calendar Bundle",
              family: "bundle-plugin",
              channel: "official",
              isOfficial: true,
              summary: "Calendar bundle",
              createdAt: 1,
              updatedAt: 1,
              latestVersion: "2.0.0",
            },
          },
        ],
      }),
    );

    await withEnvAsync(
      {
        OPENCLAW_PROFILE: scenario.profile,
        OPENCLAW_CONTAINER_HINT: scenario.container,
      },
      () => runPluginsSearchCommand(["calendar"], { limit: 5 }, mocks.runtime),
    );

    expect(mocks.fetch).toHaveBeenCalledOnce();
    const [input] = mocks.fetch.mock.calls[0]!;
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe("/api/v1/plugins/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "calendar", limit: "5" });
    expect(mocks.logs.join("\n")).toContain("openclaw-calendar");
    expect(mocks.logs.join("\n")).toContain(`Install: ${scenario.command}`);
  });

  it("writes JSON results when requested", async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ results: [] }));

    await runPluginsSearchCommand("calendar", { json: true }, mocks.runtime);

    expect(mocks.runtime.writeJson).toHaveBeenCalledWith({ results: [] }, 2);
  });

  it("leaves missing-query JSON failures to the root renderer", async () => {
    await expect(runPluginsSearchCommand([], { json: true }, mocks.runtime)).rejects.toThrow(
      "Usage: openclaw plugins search <query>",
    );

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("leaves ClawHub JSON failures to the root renderer", async () => {
    mocks.fetch.mockResolvedValueOnce(new Response("offline fixture", { status: 400 }));

    await expect(
      runPluginsSearchCommand("calendar", { json: true }, mocks.runtime),
    ).rejects.toThrow("offline fixture");

    expect(mocks.runtime.error).not.toHaveBeenCalled();
    expect(mocks.runtime.exit).not.toHaveBeenCalled();
  });

  it("rejects partial numeric search limits", async () => {
    const program = new Command();
    program.exitOverride();
    registerPluginsCli(program);

    await expect(
      program.parseAsync(["plugins", "search", "calendar", "--limit", "10ms"], { from: "user" }),
    ).rejects.toThrow("--limit must be a positive integer.");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
