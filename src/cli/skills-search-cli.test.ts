import { Command } from "commander";
import { beforeEach, expect, it, vi } from "vitest";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
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

vi.mock("../runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../runtime.js")>()),
  defaultRuntime,
}));
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

it.each([false, true])("preserves search output until cancellation (%s)", async (cancelled) => {
  const scope = new AsyncWorkScope();
  searchSkillsFromClawHubMock.mockImplementation(async () => {
    if (cancelled) {
      scope.beginClose();
    }
    return [
      skill({ installRef: "@demo-owner/calendar", version: "1.2.3" }),
      skill({ installRef: "@work-owner/calendar", version: "v1.2.3" }),
      skill({ slug: "legacy-calendar", version: "V1.2.3" }),
      skill({
        slug: "weather",
        installRef: "skills-sh:openclaw/skills/weather",
        trustState: "not-scanned-by-clawhub",
        displayName: "Weather",
        version: "canary",
      }),
      skill({
        slug: "oauth-helper",
        installRef: "@demo-owner/oauth-helper",
        displayName: "Oauth\nHelper",
        summary: "Login.\nProviders.\n\nFeatures:\n- Confirm first",
        version: "  v1.2.3\n ",
      }),
      skill({}),
    ];
  });
  await scope.run(() => runCommand(["skills", "search", "calendar"]));
  const request = searchSkillsFromClawHubMock.mock.calls[0]?.[0];
  expect(request).toEqual({ query: "calendar", limit: undefined, signal: scope.signal });
  expect(loggedLines()).toEqual(
    cancelled
      ? []
      : [
          "@demo-owner/calendar v1.2.3  Calendar",
          "@work-owner/calendar v1.2.3  Calendar",
          "legacy-calendar V1.2.3  Calendar",
          "skills-sh:openclaw/skills/weather canary  Weather  Not scanned by ClawHub",
          "@demo-owner/oauth-helper v1.2.3  Oauth Helper  Login. Providers. Features: - Confirm first",
          "calendar  Calendar",
        ],
  );
});

it("preserves raw versions in parent and leaf JSON output", async () => {
  const results = [skill({ version: "  v1.2.3\n " })];
  searchSkillsFromClawHubMock.mockResolvedValue(results);
  await runCommand(["skills", "search", "calendar", "--json"]);
  await runCommand(["skills", "--json", "search", "calendar"]);
  expect(defaultRuntime.log).not.toHaveBeenCalled();
  expect(defaultRuntime.writeJson.mock.calls).toEqual([[{ results }], [{ results }]]);
});

it("rejects partial numeric search limits", async () => {
  await expect(runCommand(["skills", "search", "calendar", "--limit", "10ms"])).rejects.toThrow(
    "--limit must be a positive integer.",
  );
  expect(searchSkillsFromClawHubMock).not.toHaveBeenCalled();
});
