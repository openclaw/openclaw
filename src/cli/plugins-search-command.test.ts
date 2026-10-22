import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawHubPackageSearchResult } from "../infra/clawhub-packages.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = vi.hoisted(() => {
  const logs: string[] = [];
  const runtime = {
    log: vi.fn((value: unknown) => logs.push(String(value))),
    error: vi.fn(),
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
  return { logs, runtime, searchClawHubPackages: vi.fn() };
});

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.runtime,
  writeRuntimeJson: (runtime: typeof mocks.runtime, value: unknown, space = 2) =>
    runtime.writeJson(value, space),
}));

vi.mock("../infra/clawhub-packages.js", () => ({
  searchClawHubPackages: mocks.searchClawHubPackages,
}));

const { runPluginsSearchCommand } = await import("./plugins-search-command.js");
const { registerPluginsCli } = await import("./plugins-cli.js");

type Package = ClawHubPackageSearchResult["package"];
function result(name: string, overrides: Partial<Package> = {}, score = 1) {
  return {
    score,
    package: {
      name,
      family: "bundle-plugin",
      channel: "community",
      isOfficial: false,
      ...overrides,
    },
  };
}

describe("plugins search command", () => {
  beforeEach(() => {
    mocks.logs.length = 0;
    vi.clearAllMocks();
    mocks.searchClawHubPackages.mockReset();
  });

  it.each([
    ["openclaw-calendar", "work", undefined, " --profile work", "openclaw-calendar@latest"],
    ["@openclaw/diffs", undefined, undefined, "", "@openclaw/diffs"],
    ["discord", undefined, undefined, "", "discord@latest"],
    ["@composio/composio", "work", "staging", " --container staging", "@composio/composio"],
  ] satisfies [string, string | undefined, string | undefined, string, string][])(
    "searches ClawHub plugin families for %s",
    async (packageName, profile, container, context, spec) => {
      mocks.searchClawHubPackages
        .mockResolvedValueOnce([
          result(packageName, { family: "code-plugin", summary: "Calendar sync" }, 12),
        ])
        .mockResolvedValueOnce([
          result("openclaw-calendar-bundle", { channel: "official", isOfficial: true }, 10),
        ]);

      await withEnvAsync(
        {
          OPENCLAW_PROFILE: profile,
          OPENCLAW_CONTAINER_HINT: container,
        },
        () => runPluginsSearchCommand(["calendar"], { limit: 5 }, mocks.runtime),
      );

      for (const family of ["code-plugin", "bundle-plugin"]) {
        expect(mocks.searchClawHubPackages).toHaveBeenCalledWith({
          query: "calendar",
          family,
          limit: 5,
        });
      }
      expect(mocks.logs.join("\n")).toContain(packageName);
      expect(mocks.logs.join("\n")).toContain(
        `Install: openclaw${context} plugins install ${spec}`,
      );
    },
  );

  it("formats catalog version labels while preserving raw JSON values", async () => {
    const results = ["1.2.3", "v1.2.3", "V1.2.3", "canary", "  v1.2.3  ", undefined].map(
      (latestVersion, index) => result(`plugin-${index}`, { latestVersion }),
    );
    mocks.searchClawHubPackages.mockResolvedValue(results);

    const program = new Command();
    registerPluginsCli(program);
    await program.parseAsync(["plugins", "search", "version"], { from: "user" });
    const output = mocks.logs.join("\n");
    for (const line of [
      "plugin-0  bundle-plugin | community | v1.2.3\n",
      "plugin-1  bundle-plugin | community | v1.2.3\n",
      "plugin-2  bundle-plugin | community | V1.2.3\n",
      "plugin-3  bundle-plugin | community | canary\n",
      "plugin-4  bundle-plugin | community | v1.2.3\n",
      "plugin-5  bundle-plugin | community\n",
    ]) {
      expect(output).toContain(line);
    }
    await program.parseAsync(["plugins", "search", "version", "--json"], { from: "user" });
    expect(mocks.runtime.writeJson).toHaveBeenCalledExactlyOnceWith({ results }, 2);
  });

  it.each([
    [[], "Usage: openclaw plugins search <query>"],
    ["calendar", "offline fixture"],
  ] satisfies [string | string[], string][])(
    "leaves JSON failure for %j to the root renderer",
    async (query, message) => {
      mocks.searchClawHubPackages.mockRejectedValueOnce(new Error("offline fixture"));
      await expect(runPluginsSearchCommand(query, { json: true }, mocks.runtime)).rejects.toThrow(
        message,
      );
      expect(mocks.runtime.error).not.toHaveBeenCalled();
      expect(mocks.runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("rejects partial numeric search limits", async () => {
    const program = new Command();
    program.exitOverride();
    registerPluginsCli(program);

    await expect(
      program.parseAsync(["plugins", "search", "calendar", "--limit", "10ms"], { from: "user" }),
    ).rejects.toThrow("--limit must be a positive integer.");
    expect(mocks.searchClawHubPackages).not.toHaveBeenCalled();
  });
});
