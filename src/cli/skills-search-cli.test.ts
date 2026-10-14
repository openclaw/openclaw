import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerSkillsSearchCli } from "./skills-search-cli.js";

const { searchSkillsFromClawHubMock, runtimeLogs, runtimeStdout, defaultRuntime } = vi.hoisted(
  () => {
    const logs: string[] = [];
    const stdout: string[] = [];
    return {
      searchSkillsFromClawHubMock: vi.fn(),
      runtimeLogs: logs,
      runtimeStdout: stdout,
      defaultRuntime: {
        log: vi.fn((value: string) => logs.push(value)),
        error: vi.fn(),
        exit: vi.fn(),
        writeJson: vi.fn((value: unknown) => stdout.push(JSON.stringify(value, null, 2))),
      },
    };
  },
);

vi.mock("../runtime.js", () => ({ defaultRuntime }));
vi.mock("../skills/lifecycle/clawhub.js", () => ({
  searchSkillsFromClawHub: searchSkillsFromClawHubMock,
}));

describe("skills search CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runtimeLogs.length = 0;
    runtimeStdout.length = 0;
    searchSkillsFromClawHubMock.mockReset().mockResolvedValue([]);
  });

  async function runCommand(args: string[]) {
    const program = new Command().exitOverride();
    registerSkillsSearchCli(program.command("skills").option("--json", "Output as JSON", false));
    await program.parseAsync(args, { from: "user" });
  }

  it.each([
    {
      name: "distinguishes duplicate slugs by owner",
      query: "calendar",
      results: [
        {
          slug: "calendar",
          ownerHandle: "demo-owner",
          installRef: "@demo-owner/calendar",
          displayName: "Calendar",
          summary: "CalDAV helpers",
          version: "1.2.3",
        },
        {
          slug: "calendar",
          ownerHandle: "work-owner",
          installRef: "@work-owner/calendar",
          displayName: "Team Calendar",
        },
      ],
      lines: [
        "@demo-owner/calendar v1.2.3  Calendar  CalDAV helpers",
        "@work-owner/calendar  Team Calendar",
      ],
    },
    {
      name: "keeps bare slugs when the owner is missing",
      query: "calendar",
      results: [{ slug: "legacy-calendar", displayName: "Legacy Calendar" }],
      lines: ["legacy-calendar  Legacy Calendar"],
    },
    {
      name: "labels skills.sh entries as unscanned",
      query: "weather",
      results: [
        {
          slug: "weather",
          installRef: "skills-sh:openclaw/skills/weather",
          trustState: "not-scanned-by-clawhub",
          displayName: "Weather",
          summary: "Forecast helpers",
        },
      ],
      lines: [
        "skills-sh:openclaw/skills/weather  Weather  Forecast helpers  Not scanned by ClawHub",
      ],
    },
    {
      name: "keeps multiline metadata on one terminal line",
      query: "oauth-helper",
      results: [
        {
          slug: "oauth-helper",
          ownerHandle: "demo-owner",
          installRef: "@demo-owner/oauth-helper",
          displayName: "Oauth\nHelper",
          summary:
            "Automate OAuth login flows.\nSupports multiple providers.\n\nFeatures:\n- Confirm before authorizing",
        },
      ],
      lines: [
        "@demo-owner/oauth-helper  Oauth Helper  Automate OAuth login flows. Supports multiple providers. Features: - Confirm before authorizing",
      ],
    },
  ])("$name", async ({ query, results, lines }) => {
    searchSkillsFromClawHubMock.mockResolvedValue(results);
    await runCommand(["skills", "search", query]);
    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({ query, limit: undefined });
    expect(runtimeLogs).toEqual(lines);
  });

  it("formats ClawHub skill versions without changing JSON output", async () => {
    const results = ["1.2.3", "v1.2.3", "V1.2.3", "canary", "  v1.2.3\n ", undefined].map(
      (version, index) => ({
        score: 0.9,
        slug: `calendar-${index}`,
        ownerHandle: "demo-owner",
        displayName: "Calendar",
        summary: "CalDAV helpers",
        version,
        updatedAt: 1_700_000_000_000,
      }),
    );
    searchSkillsFromClawHubMock.mockResolvedValue(results);

    await runCommand(["skills", "search", "calendar", "--json"]);

    expect(runtimeLogs).toEqual([]);
    expect(runtimeStdout).toEqual([JSON.stringify({ results }, null, 2)]);

    await runCommand(["skills", "--json", "search", "calendar"]);
    expect(runtimeLogs).toEqual([]);
    expect(runtimeStdout).toEqual(Array(2).fill(JSON.stringify({ results }, null, 2)));

    await runCommand(["skills", "search", "calendar"]);

    expect(runtimeLogs).toEqual([
      "calendar-0 v1.2.3  Calendar  CalDAV helpers",
      "calendar-1 v1.2.3  Calendar  CalDAV helpers",
      "calendar-2 V1.2.3  Calendar  CalDAV helpers",
      "calendar-3 canary  Calendar  CalDAV helpers",
      "calendar-4 v1.2.3  Calendar  CalDAV helpers",
      "calendar-5  Calendar  CalDAV helpers",
    ]);
  });

  it("rejects partial numeric search limits", async () => {
    await expect(runCommand(["skills", "search", "calendar", "--limit", "10ms"])).rejects.toThrow(
      "--limit must be a positive integer.",
    );
    expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
  });
});
