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

  it("distinguishes duplicate ClawHub skill slugs by owner", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
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
    ]);

    await runCommand(["skills", "search", "calendar"]);

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: "calendar",
      limit: undefined,
    });
    expect(runtimeLogs).toEqual([
      "@demo-owner/calendar v1.2.3  Calendar  CalDAV helpers",
      "@work-owner/calendar  Team Calendar",
    ]);
  });

  it("keeps bare skill slugs when ClawHub omits the owner", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "legacy-calendar",
        displayName: "Legacy Calendar",
      },
    ]);

    await runCommand(["skills", "search", "calendar"]);

    expect(runtimeLogs).toEqual(["legacy-calendar  Legacy Calendar"]);
  });

  it("shows skills.sh entries in normal ClawHub search results", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "weather",
        installRef: "skills-sh:openclaw/skills/weather",
        trustState: "not-scanned-by-clawhub",
        displayName: "Weather",
        summary: "Forecast helpers",
      },
    ]);

    await runCommand(["skills", "search", "weather"]);

    expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({
      query: "weather",
      limit: undefined,
    });
    expect(runtimeLogs).toEqual([
      "skills-sh:openclaw/skills/weather  Weather  Forecast helpers  Not scanned by ClawHub",
    ]);
  });

  it("keeps multiline ClawHub search metadata on one terminal line", async () => {
    searchSkillsFromClawHubMock.mockResolvedValue([
      {
        slug: "oauth-helper",
        ownerHandle: "demo-owner",
        installRef: "@demo-owner/oauth-helper",
        displayName: "Oauth\nHelper",
        summary:
          "Automate OAuth login flows.\nSupports multiple providers.\n\nFeatures:\n- Confirm before authorizing",
      },
    ]);

    await runCommand(["skills", "search", "oauth-helper"]);

    expect(runtimeLogs).toEqual([
      "@demo-owner/oauth-helper  Oauth Helper  Automate OAuth login flows. Supports multiple providers. Features: - Confirm before authorizing",
    ]);
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
