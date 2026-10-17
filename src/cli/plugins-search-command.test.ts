import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ClawHubPackageSearchResult } from "../infra/clawhub-packages.js";
import { withEnvAsync } from "../test-utils/env.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  const { runtimeLogs: logs, defaultRuntime: runtime } = createCliRuntimeMock(vi);
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

      // catalog-search.test.ts owns family/query/limit forwarding; assert rendered results here.
      expect(mocks.logs.join("\n")).toContain("openclaw-calendar-bundle");
      expect(mocks.logs.join("\n")).toContain(packageName);
      expect(mocks.logs.join("\n")).toContain(
        `Install: openclaw${context} plugins install ${spec}`,
      );
    },
  );

  it("formats catalog version labels while preserving raw JSON values", async () => {
    // Version normalization variants are owned by skills-search-cli.test.ts.
    const results = ["1.2.3", undefined].map((latestVersion, index) =>
      result(`plugin-${index}`, { latestVersion }),
    );
    mocks.searchClawHubPackages.mockResolvedValue(results);

    const program = new Command();
    registerPluginsCli(program);
    await program.parseAsync(["plugins", "search", "version"], { from: "user" });
    const output = mocks.logs.join("\n");
    expect(output).toContain("plugin-0  bundle-plugin | community | v1.2.3\n");
    expect(output).toContain("plugin-1  bundle-plugin | community\n");
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

  it("strips terminal controls from registry package names and summaries", async () => {
    mocks.searchClawHubPackages.mockResolvedValue([
      {
        score: 9,
        package: {
          name: "evil\u001b]0;x\u0007SEARCH_NAME_MARKER",
          family: "code-plugin",
          latestVersion: "1.0.0",
          summary: "desc\u001b]0;y\u0007SEARCH_SUMMARY_MARKER",
          createdAt: 1,
          updatedAt: 1,
        },
      },
      {
        score: 1,
        package: {
          name: "plain-plugin",
          family: "code-plugin",
          latestVersion: "2.0.0",
          summary: "plain summary",
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ]);

    await runPluginsSearchCommand(["evil"], {}, mocks.runtime);

    const raw = mocks.logs.join("\n");
    expect(raw).not.toContain("evil\u001b]0;x\u0007SEARCH_NAME_MARKER");
    expect(raw).not.toContain("desc\u001b]0;y\u0007SEARCH_SUMMARY_MARKER");
    expect(raw).not.toContain("\u0007");
    expect(raw).toContain("SEARCH_NAME_MARKER");
    expect(raw).toContain("SEARCH_SUMMARY_MARKER");
    expect(raw).toContain("plain-plugin");
  });

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
