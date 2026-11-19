import { describe, expect, it } from "vitest";
import {
  runDatedTodoUpsert,
  validateDatedTodoReport,
} from "../../scripts/github/dated-todo-upsert.mjs";

const MARKER = "<!-- dated-todo-sweep -->";
const TODO_ITEM = "- [ ] src/urgent.ts:7 — remove expired compatibility (2026-07-01)";
const REPORT = [
  "# Dated TODO sweep",
  "Generated for 2026-07-25 UTC.",
  "## OVERDUE",
  TODO_ITEM,
  "## DUE within 30 days",
  "_None._",
  "## FUTURE",
  "_None._",
  "Dropped as noise: 2",
].join("\n\n");

const EMPTY_TRACKER = `${MARKER}\n\n## OVERDUE\n\n## DUE within 30 days\n\n## FUTURE\n`;

function issue(number: number, options: { trusted: boolean; body?: string }) {
  return {
    number,
    state: "open",
    body: options.body ?? `${MARKER}\n\n${REPORT}`,
    user: { type: options.trusted ? "Bot" : "User" },
    labels: options.trusted ? [{ name: "dated-todo-sweep" }] : [],
  };
}

const emptyTracker = () => issue(10, { trusted: true, body: EMPTY_TRACKER });

function harness(
  searchItems: ReturnType<typeof issue>[],
  options: {
    comments?: Array<{ body?: string; performed_via_github_app?: { id: number } }>;
    commentError?: Error;
    searchError?: Error;
  } = {},
) {
  const calls = {
    create: [] as unknown[],
    update: [] as unknown[],
    comment: [] as unknown[],
    warnings: [] as string[],
    sequence: [] as string[],
  };
  const record =
    (kind: "create" | "update" | "comment", data = {}) =>
    async (args: unknown) => {
      calls[kind].push(args);
      if (kind !== "create") {
        calls.sequence.push(kind);
      }
      if (kind === "comment" && options.commentError) {
        throw options.commentError;
      }
      return { data };
    };
  const github = {
    paginate: async (_method: unknown, args: Record<string, unknown>) =>
      "labels" in args
        ? searchItems.filter((candidate) =>
            candidate.labels.some((label) => label.name === "dated-todo-sweep"),
          )
        : (options.comments ?? []),
    rest: {
      search: {
        issuesAndPullRequests: async () => {
          if (options.searchError) {
            throw options.searchError;
          }
          return { data: { items: searchItems } };
        },
      },
      issues: {
        getLabel: async () => ({ data: { name: "dated-todo-sweep" } }),
        createLabel: async () => ({ data: {} }),
        create: record("create", { number: 123 }),
        update: record("update"),
        createComment: record("comment"),
        listComments: async () => ({ data: options.comments ?? [] }),
        listForRepo: async () => ({ data: searchItems }),
      },
    },
  };
  const core = {
    info: () => {},
    warning: (message: string) => calls.warnings.push(message),
  };
  const run = () =>
    runDatedTodoUpsert({
      github,
      core,
      context: { repo: { owner: "openclaw", repo: "openclaw" } },
      report: REPORT,
    });
  return { calls, run };
}

async function notificationRetry(appId?: number) {
  const tracker = emptyTracker();
  const first = harness([tracker]);
  await first.run();
  const { body } = first.calls.comment[0] as { body: string };
  return harness([tracker], {
    comments: [
      { body, ...(appId === undefined ? {} : { performed_via_github_app: { id: appId } }) },
    ],
  });
}

describe("dated TODO issue upsert", () => {
  it("ignores a public marker spoof and updates only the bot-and-label tracker", async () => {
    const spoof = issue(99, { trusted: false });
    const tracker = emptyTracker();
    const { calls, run } = harness([spoof, tracker]);

    await run();

    expect(calls).toMatchObject({
      create: [],
      update: [{ issue_number: tracker.number, state: "open" }],
      comment: [{ issue_number: tracker.number, body: expect.stringContaining("src/urgent.ts:7") }],
      sequence: ["comment", "update"],
      warnings: [expect.stringContaining("Ignored 1 untrusted")],
    });
  });

  it("updates the canonical tracker when diagnostics-only search fails", async () => {
    const tracker = issue(10, { trusted: true });
    const { calls, run } = harness([tracker], {
      searchError: new Error("secondary rate limit"),
    });

    await run();

    expect(calls.update).toEqual([expect.objectContaining({ issue_number: tracker.number })]);
    expect(calls.warnings).toEqual([expect.stringContaining("Skipping diagnostics-only")]);
  });

  it("does not advance the issue body when an urgent notification fails", async () => {
    const tracker = emptyTracker();
    const { calls, run } = harness([tracker], {
      commentError: new Error("comment failed"),
    });

    await expect(run()).rejects.toThrow("comment failed");

    expect(calls.update).toHaveLength(0);
  });

  it("does not duplicate an urgent comment when retrying a failed body update", async () => {
    const retry = await notificationRetry(2729701);
    await retry.run();

    expect(retry.calls.comment).toHaveLength(0);
    expect(retry.calls.update).toHaveLength(1);
  });

  it("ignores a notification marker copied by an ordinary commenter", async () => {
    const spoofed = await notificationRetry();
    await spoofed.run();

    expect(spoofed.calls.comment).toHaveLength(1);
  });

  it("creates a labeled tracker instead of overwriting an untrusted marker issue", async () => {
    const { calls, run } = harness([issue(99, { trusted: false })]);

    await run();

    expect(calls.update).toHaveLength(0);
    expect(calls.create).toEqual([
      expect.objectContaining({ labels: ["dated-todo-sweep"], title: "Dated TODO sweep" }),
    ]);
  });
});

describe("dated TODO report validation", () => {
  const validate =
    (report: string, options?: Parameters<typeof validateDatedTodoReport>[1]) => () =>
      validateDatedTodoReport(report, options);
  it.each([
    ["invalid date", "(2026-07-01)", "(2026-99-01)", /Invalid dated TODO checklist item/u],
    ["future OVERDUE date", "(2026-07-01)", "(2027-01-01)", /Non-overdue date/u],
    [
      "late DUE date",
      "## DUE within 30 days\n\n_None._",
      "## DUE within 30 days\n\n- [ ] src/due.ts:9 — revisit gate (2026-08-25)",
      /outside the 30-day due window/u,
    ],
    ...[
      "notify @maintainers",
      "see https://example.com",
      "follow up in GH-123",
      "remove _expired_ compatibility",
    ].map(
      (summary) =>
        [summary, "remove expired compatibility", summary, /Non-plain-text summary/u] as const,
    ),
    [
      "unexpected prologue",
      "Generated for 2026-07-25 UTC.\n\n",
      "Generated for 2026-07-25 UTC.\n\n@maintainers\n\n",
      /prologue or section order/u,
    ],
  ] as const)("rejects %s", (_name, from, to, error) => {
    expect(validate(REPORT.replace(from, to))).toThrow(error);
  });

  it("binds the report date and file locations to the fresh checkout", () => {
    const verifiedReport = REPORT.replace("src/urgent.ts:7", "scripts/github/pr-ci-sweeper.mjs:1");

    const checkout = { expectedDate: "2026-07-25", repoRoot: process.cwd() };
    expect(validate(verifiedReport, checkout)).not.toThrow();
    expect(validate(verifiedReport, { expectedDate: "2026-07-26" })).toThrow(
      /expected 2026-07-26/u,
    );
    expect(validate(REPORT, checkout)).toThrow(/Untracked or missing repository path/u);
  });

  it("allows underscores inside plain identifiers", () => {
    expect(
      validate(REPORT.replace("remove expired compatibility", "remove media_legacy compatibility")),
    ).not.toThrow();
  });
});
