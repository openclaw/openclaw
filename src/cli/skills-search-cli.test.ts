import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { registerSkillsSearchCli } from "./skills-search-cli.js";

const { searchSkillsFromClawHubMock, defaultRuntime } = vi.hoisted(() => ({
  searchSkillsFromClawHubMock: vi.fn(),
  defaultRuntime: { log: vi.fn(), error: vi.fn(), exit: vi.fn(), writeJson: vi.fn() },
}));
const loggedLines = () => defaultRuntime.log.mock.calls.map(([line]) => line);
const skill = <T extends object>(fields: T) => ({
  slug: "calendar",
  displayName: "Calendar",
  ...fields,
});

vi.mock("../runtime.js", () => ({ defaultRuntime }));
vi.mock("../skills/lifecycle/clawhub.js", () => ({
  searchSkillsFromClawHub: searchSkillsFromClawHubMock,
}));

beforeEach(() => {
  vi.clearAllMocks();
  searchSkillsFromClawHubMock.mockReset().mockResolvedValue([]);
});

async function runCommand(args: string[]) {
  const program = new Command().exitOverride();
  registerSkillsSearchCli(program.command("skills").option("--json", "Output as JSON", false));
  await program.parseAsync(args, { from: "user" });
}

it("formats mixed search results with owner refs, trust labels and single-line metadata", async () => {
  searchSkillsFromClawHubMock.mockResolvedValue([
    skill({ installRef: "@demo-owner/calendar" }),
    skill({ installRef: "@work-owner/calendar", displayName: "Team Calendar" }),
    { slug: "legacy-calendar", displayName: "Legacy Calendar" },
    skill({
      slug: "weather",
      installRef: "skills-sh:openclaw/skills/weather",
      trustState: "not-scanned-by-clawhub",
      displayName: "Weather",
    }),
    skill({
      slug: "oauth-helper",
      installRef: "@demo-owner/oauth-helper",
      displayName: "Oauth\nHelper",
      summary: "Login.\nProviders.\n\nFeatures:\n- Confirm first",
    }),
  ]);
  await runCommand(["skills", "search", "calendar"]);
  expect(searchSkillsFromClawHubMock).toHaveBeenCalledWith({ query: "calendar", limit: undefined });
  expect(loggedLines()).toEqual([
    "@demo-owner/calendar  Calendar",
    "@work-owner/calendar  Team Calendar",
    "legacy-calendar  Legacy Calendar",
    "skills-sh:openclaw/skills/weather  Weather  Not scanned by ClawHub",
    "@demo-owner/oauth-helper  Oauth Helper  Login. Providers. Features: - Confirm first",
  ]);
});

it("formats ClawHub skill versions without changing JSON output", async () => {
  const results = ["1.2.3", "v1.2.3", "V1.2.3", "canary", "  v1.2.3\n ", undefined].map(
    (version, index) =>
      skill({
        score: 0.9,
        slug: `calendar-${index}`,
        ownerHandle: "demo-owner",
        version,
      }),
  );
  searchSkillsFromClawHubMock.mockResolvedValue(results);

  await runCommand(["skills", "search", "calendar", "--json"]);

  expect(defaultRuntime.log).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson.mock.calls).toEqual([[{ results }]]);

  await runCommand(["skills", "--json", "search", "calendar"]);
  expect(defaultRuntime.log).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson.mock.calls).toEqual([[{ results }], [{ results }]]);

  await runCommand(["skills", "search", "calendar"]);

  expect(loggedLines()).toEqual([
    "calendar-0 v1.2.3  Calendar",
    "calendar-1 v1.2.3  Calendar",
    "calendar-2 V1.2.3  Calendar",
    "calendar-3 canary  Calendar",
    "calendar-4 v1.2.3  Calendar",
    "calendar-5  Calendar",
  ]);
});

it("rejects partial numeric search limits", async () => {
  await expect(runCommand(["skills", "search", "calendar", "--limit", "10ms"])).rejects.toThrow(
    "--limit must be a positive integer.",
  );
  expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
});
