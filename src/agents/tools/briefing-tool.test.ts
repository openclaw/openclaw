import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the section fetchers (module does not exist yet -- RED phase)
const fetchCalendarSection = vi.fn();
const fetchEmailSection = vi.fn();
const fetchTicketsSection = vi.fn();
const fetchPrsSection = vi.fn();
const fetchSlackSection = vi.fn();
const fetchShippedSection = vi.fn();
const fetchInProgressSection = vi.fn();
const fetchBlockedSection = vi.fn();
const fetchDiscussionsSection = vi.fn();
const fetchNumbersSection = vi.fn();
const fetchPeopleSection = vi.fn();

vi.mock("./briefing-sections.js", () => ({
  fetchCalendarSection: (...args: unknown[]) => fetchCalendarSection(...args),
  fetchEmailSection: (...args: unknown[]) => fetchEmailSection(...args),
  fetchTicketsSection: (...args: unknown[]) => fetchTicketsSection(...args),
  fetchPrsSection: (...args: unknown[]) => fetchPrsSection(...args),
  fetchSlackSection: (...args: unknown[]) => fetchSlackSection(...args),
  fetchShippedSection: (...args: unknown[]) => fetchShippedSection(...args),
  fetchInProgressSection: (...args: unknown[]) => fetchInProgressSection(...args),
  fetchBlockedSection: (...args: unknown[]) => fetchBlockedSection(...args),
  fetchDiscussionsSection: (...args: unknown[]) => fetchDiscussionsSection(...args),
  fetchNumbersSection: (...args: unknown[]) => fetchNumbersSection(...args),
  fetchPeopleSection: (...args: unknown[]) => fetchPeopleSection(...args),
}));

// Mock the formatters (module does not exist yet -- RED phase)
const formatMorningBriefing = vi.fn();
const formatWeeklyRecap = vi.fn();
const formatSectionError = vi.fn();

vi.mock("./briefing-format.js", () => ({
  formatMorningBriefing: (...args: unknown[]) => formatMorningBriefing(...args),
  formatWeeklyRecap: (...args: unknown[]) => formatWeeklyRecap(...args),
  formatSectionError: (...args: unknown[]) => formatSectionError(...args),
}));

// Mock the config store (module does not exist yet -- RED phase)
const loadBriefingConfig = vi.fn();
const saveBriefingConfig = vi.fn();

vi.mock("./briefing-config.js", () => ({
  loadBriefingConfig: (...args: unknown[]) => loadBriefingConfig(...args),
  saveBriefingConfig: (...args: unknown[]) => saveBriefingConfig(...args),
  DEFAULT_BRIEFING_CONFIG: {
    morning: {
      enabled: true,
      schedule: "0 8 * * 1-5",
      delivery_channel: "whatsapp",
      sections: ["calendar", "email", "tickets", "prs", "slack"],
    },
    weekly: {
      enabled: true,
      schedule: "0 16 * * 5",
      delivery_channel: "whatsapp",
      sections: ["shipped", "in_progress", "blocked", "discussions", "numbers", "people"],
    },
  },
}));

// Import the module under test (does not exist yet -- RED phase)
import { handleBriefingAction } from "./briefing-tool.js";

const defaultMorningConfig = {
  enabled: true,
  schedule: "0 8 * * 1-5",
  delivery_channel: "whatsapp",
  sections: ["calendar", "email", "tickets", "prs", "slack"],
};

const defaultWeeklyConfig = {
  enabled: true,
  schedule: "0 16 * * 5",
  delivery_channel: "whatsapp",
  sections: ["shipped", "in_progress", "blocked", "discussions", "numbers", "people"],
};

const defaultConfig = {
  morning: defaultMorningConfig,
  weekly: defaultWeeklyConfig,
};

beforeEach(() => {
  fetchCalendarSection.mockReset();
  fetchEmailSection.mockReset();
  fetchTicketsSection.mockReset();
  fetchPrsSection.mockReset();
  fetchSlackSection.mockReset();
  fetchShippedSection.mockReset();
  fetchInProgressSection.mockReset();
  fetchBlockedSection.mockReset();
  fetchDiscussionsSection.mockReset();
  fetchNumbersSection.mockReset();
  fetchPeopleSection.mockReset();
  formatMorningBriefing.mockReset();
  formatWeeklyRecap.mockReset();
  formatSectionError.mockReset();
  loadBriefingConfig.mockReset();
  saveBriefingConfig.mockReset();

  // Default: return default config
  loadBriefingConfig.mockResolvedValue(defaultConfig);
  saveBriefingConfig.mockResolvedValue(undefined);

  // Default: section fetchers return data
  fetchCalendarSection.mockResolvedValue({
    title: "Calendar",
    items: [
      { time: "09:00-09:30", title: "Standup", org: "zenloop" },
      { time: "11:00-12:00", title: "Product sync", org: "edubites" },
    ],
  });
  fetchEmailSection.mockResolvedValue({
    title: "Email",
    urgent: 1,
    needsReply: 3,
    unreadCount: { edubites: 5, protaige: 2, zenloop: 8 },
  });
  fetchTicketsSection.mockResolvedValue({
    title: "Tickets",
    asana: [{ title: "Fix auth", status: "in_progress" }],
    monday: [{ title: "Review content", status: "Review" }],
  });
  fetchPrsSection.mockResolvedValue({
    title: "PRs",
    prs: [{ title: "Add feature X", org: "protaige", author: "jonas" }],
  });
  fetchSlackSection.mockResolvedValue({
    title: "Slack",
    highlights: ["@mention in #engineering", "DM from Verena"],
  });

  // Default: weekly section fetchers
  fetchShippedSection.mockResolvedValue({
    title: "Shipped",
    prs: [{ title: "Feature Y merged", org: "zenloop" }],
  });
  fetchInProgressSection.mockResolvedValue({
    title: "In Progress",
    tasks: [{ title: "Auth migration", assignee: "jonas" }],
  });
  fetchBlockedSection.mockResolvedValue({
    title: "Blocked",
    blockers: [],
  });
  fetchDiscussionsSection.mockResolvedValue({
    title: "Discussions",
    summaries: ["Release plan discussed in #platform"],
  });
  fetchNumbersSection.mockResolvedValue({
    title: "Numbers",
    commits: 42,
    prsMerged: 7,
    velocity: "85%",
  });
  fetchPeopleSection.mockResolvedValue({
    title: "People",
    mostActive: ["jonas", "verena"],
    mightNeedHelp: [],
  });

  // Default: formatters return formatted strings
  formatMorningBriefing.mockReturnValue(
    "# Morning Briefing\n\n## Calendar\n...\n\n## Email\n...\n\n## Tickets\n...\n\n## PRs\n...\n\n## Slack\n...",
  );
  formatWeeklyRecap.mockReturnValue(
    "# Weekly Recap\n\n## Shipped\n...\n\n## In Progress\n...\n\n## Blocked\n...",
  );
  formatSectionError.mockImplementation(
    (name: string) => `## ${name}\n[Unable to fetch ${name.toLowerCase()} data]`,
  );
});

describe("handleBriefingAction", () => {
  // ── Test 1: Morning briefing all sections ──
  describe("action: morning", () => {
    it("returns formatted string with all default sections", async () => {
      const result = await handleBriefingAction({ action: "morning" });
      const details = result.details as { ok: boolean; briefing: string };

      expect(details.ok).toBe(true);
      expect(details.briefing).toBeDefined();
      expect(typeof details.briefing).toBe("string");

      expect(fetchCalendarSection).toHaveBeenCalled();
      expect(fetchEmailSection).toHaveBeenCalled();
      expect(fetchTicketsSection).toHaveBeenCalled();
      expect(fetchPrsSection).toHaveBeenCalled();
      expect(fetchSlackSection).toHaveBeenCalled();
      expect(formatMorningBriefing).toHaveBeenCalled();
    });

    // ── Test 2: Morning briefing custom date ──
    it("passes custom date to section fetchers", async () => {
      await handleBriefingAction({ action: "morning", date: "2026-02-16" });

      const calendarArgs = fetchCalendarSection.mock.calls[0] as unknown[];
      const opts = calendarArgs[0] as Record<string, unknown>;
      expect(opts.date).toBe("2026-02-16");
    });

    // ── Test 3: Morning briefing partial failure ──
    it("still returns briefing when one section fails", async () => {
      fetchEmailSection.mockRejectedValueOnce(new Error("Gmail API unavailable"));

      const result = await handleBriefingAction({ action: "morning" });
      const details = result.details as { ok: boolean; briefing: string; errors: string[] };

      expect(details.ok).toBe(true);
      expect(details.briefing).toBeDefined();
      expect(details.errors).toBeDefined();
      expect(details.errors).toHaveLength(1);
      expect(details.errors[0]).toContain("email");

      // Other sections still fetched
      expect(fetchCalendarSection).toHaveBeenCalled();
      expect(fetchTicketsSection).toHaveBeenCalled();
      expect(fetchPrsSection).toHaveBeenCalled();
      expect(fetchSlackSection).toHaveBeenCalled();
      expect(formatSectionError).toHaveBeenCalledWith("Email", expect.any(Error));
    });

    // ── Test 4: Morning briefing all failures ──
    it("returns briefing with all error notes when all sections fail", async () => {
      fetchCalendarSection.mockRejectedValueOnce(new Error("Calendar API down"));
      fetchEmailSection.mockRejectedValueOnce(new Error("Gmail API down"));
      fetchTicketsSection.mockRejectedValueOnce(new Error("Asana API down"));
      fetchPrsSection.mockRejectedValueOnce(new Error("GitHub API down"));
      fetchSlackSection.mockRejectedValueOnce(new Error("Slack API down"));

      const result = await handleBriefingAction({ action: "morning" });
      const details = result.details as { ok: boolean; briefing: string; errors: string[] };

      expect(details.ok).toBe(true);
      expect(details.briefing).toBeDefined();
      expect(details.errors).toHaveLength(5);
    });

    // ── Test 12: Filtered morning briefing ──
    it("only fetches enabled sections from config", async () => {
      loadBriefingConfig.mockResolvedValueOnce({
        ...defaultConfig,
        morning: {
          ...defaultMorningConfig,
          sections: ["calendar", "email"],
        },
      });

      await handleBriefingAction({ action: "morning" });

      expect(fetchCalendarSection).toHaveBeenCalled();
      expect(fetchEmailSection).toHaveBeenCalled();
      expect(fetchTicketsSection).not.toHaveBeenCalled();
      expect(fetchPrsSection).not.toHaveBeenCalled();
      expect(fetchSlackSection).not.toHaveBeenCalled();
    });

    // ── Test 14: Morning sections have correct labels ──
    it("passes section data to formatter with correct labels", async () => {
      await handleBriefingAction({ action: "morning" });

      const formatterArgs = formatMorningBriefing.mock.calls[0] as unknown[];
      const sections = formatterArgs[0] as Array<{ title: string }>;

      expect(sections).toBeDefined();
      expect(Array.isArray(sections)).toBe(true);
      expect(sections.length).toBe(5);

      const titles = sections.map((s) => s.title);
      expect(titles).toContain("Calendar");
      expect(titles).toContain("Email");
      expect(titles).toContain("Tickets");
      expect(titles).toContain("PRs");
      expect(titles).toContain("Slack");
    });
  });

  // ── Test 5: Weekly recap all sections ──
  describe("action: weekly", () => {
    it("returns formatted string with all default sections", async () => {
      const result = await handleBriefingAction({ action: "weekly" });
      const details = result.details as { ok: boolean; briefing: string };

      expect(details.ok).toBe(true);
      expect(details.briefing).toBeDefined();
      expect(typeof details.briefing).toBe("string");

      expect(fetchShippedSection).toHaveBeenCalled();
      expect(fetchInProgressSection).toHaveBeenCalled();
      expect(fetchBlockedSection).toHaveBeenCalled();
      expect(fetchDiscussionsSection).toHaveBeenCalled();
      expect(fetchNumbersSection).toHaveBeenCalled();
      expect(fetchPeopleSection).toHaveBeenCalled();
      expect(formatWeeklyRecap).toHaveBeenCalled();
    });

    // ── Test 6: Weekly recap custom week ──
    it("uses custom week_start for date range", async () => {
      await handleBriefingAction({ action: "weekly", week_start: "2026-02-09" });

      const shippedArgs = fetchShippedSection.mock.calls[0] as unknown[];
      const opts = shippedArgs[0] as Record<string, unknown>;
      expect(opts.weekStart).toBe("2026-02-09");
      expect(opts.weekEnd).toBe("2026-02-13");
    });

    // ── Test 7: Weekly recap partial failure ──
    it("still returns recap when some sections fail", async () => {
      fetchShippedSection.mockRejectedValueOnce(new Error("GitHub API down"));
      fetchDiscussionsSection.mockRejectedValueOnce(new Error("Slack API down"));

      const result = await handleBriefingAction({ action: "weekly" });
      const details = result.details as { ok: boolean; briefing: string; errors: string[] };

      expect(details.ok).toBe(true);
      expect(details.briefing).toBeDefined();
      expect(details.errors).toHaveLength(2);
    });

    // ── Test 15: Weekly date range calculation ──
    it("resolves week_start to Monday when called mid-week", async () => {
      // When no week_start is provided, the tool should calculate
      // the Monday of the current week
      await handleBriefingAction({ action: "weekly" });

      const shippedArgs = fetchShippedSection.mock.calls[0] as unknown[];
      const opts = shippedArgs[0] as Record<string, unknown>;

      // weekStart should be a Monday (ISO day 1)
      const weekStart = new Date(opts.weekStart as string);
      expect(weekStart.getDay()).toBe(1); // Monday
    });
  });

  // ── Test 8-11: Configure action ──
  describe("action: configure", () => {
    // ── Test 8: Configure enable sections ──
    it("updates sections for a briefing type", async () => {
      const result = await handleBriefingAction({
        action: "configure",
        type: "morning",
        sections: ["calendar", "prs"],
      });

      const details = result.details as { ok: boolean; config: typeof defaultConfig };
      expect(details.ok).toBe(true);
      expect(details.config.morning.sections).toEqual(["calendar", "prs"]);

      expect(saveBriefingConfig).toHaveBeenCalled();
      const savedConfig = saveBriefingConfig.mock.calls[0]?.[0] as typeof defaultConfig;
      expect(savedConfig.morning.sections).toEqual(["calendar", "prs"]);
    });

    // ── Test 9: Configure disable briefing ──
    it("disables a briefing type", async () => {
      const result = await handleBriefingAction({
        action: "configure",
        type: "morning",
        enabled: false,
      });

      const details = result.details as { ok: boolean; config: typeof defaultConfig };
      expect(details.ok).toBe(true);
      expect(details.config.morning.enabled).toBe(false);
    });

    // ── Test 10: Configure update schedule ──
    it("updates schedule for a briefing type", async () => {
      const result = await handleBriefingAction({
        action: "configure",
        type: "weekly",
        schedule: "0 17 * * 5",
      });

      const details = result.details as { ok: boolean; config: typeof defaultConfig };
      expect(details.ok).toBe(true);
      expect(details.config.weekly.schedule).toBe("0 17 * * 5");
    });

    // ── Test 11: Configure delivery channel ──
    it("updates delivery channel for a briefing type", async () => {
      const result = await handleBriefingAction({
        action: "configure",
        type: "morning",
        delivery_channel: "slack",
      });

      const details = result.details as { ok: boolean; config: typeof defaultConfig };
      expect(details.ok).toBe(true);
      expect(details.config.morning.delivery_channel).toBe("slack");
    });

    it("throws when type is missing", async () => {
      await expect(handleBriefingAction({ action: "configure" })).rejects.toThrow(/type required/);
    });

    it("throws when type is invalid", async () => {
      await expect(handleBriefingAction({ action: "configure", type: "daily" })).rejects.toThrow(
        /type must be morning or weekly/,
      );
    });
  });

  // ── Test 13: Default config fallback ──
  describe("default config", () => {
    it("uses default config when none exists in storage", async () => {
      loadBriefingConfig.mockResolvedValueOnce(null);

      const result = await handleBriefingAction({ action: "morning" });
      const details = result.details as { ok: boolean; briefing: string };

      expect(details.ok).toBe(true);
      expect(details.briefing).toBeDefined();

      // All 5 default morning sections should be fetched
      expect(fetchCalendarSection).toHaveBeenCalled();
      expect(fetchEmailSection).toHaveBeenCalled();
      expect(fetchTicketsSection).toHaveBeenCalled();
      expect(fetchPrsSection).toHaveBeenCalled();
      expect(fetchSlackSection).toHaveBeenCalled();
    });
  });

  // ── Unknown action ──
  describe("unknown action", () => {
    it("throws error with action name", async () => {
      await expect(handleBriefingAction({ action: "daily" })).rejects.toThrow(
        /Unknown action: daily/,
      );
    });
  });
});
