import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDeepStrictEqual } from "node:util";
import {
  runBarnacleAutoResponse,
  managedLabelSpecs,
} from "../../scripts/github/barnacle-auto-response.mjs";
import { reader, snapshotOf } from "../../scripts/github/barnacle-state.mjs";
import {
  closeMessage,
  closeBody,
  noticeBody,
  policyFor,
  auditRecentBugClosures,
  evaluateItem,
  runStaleLifecycle,
  selectScanSlice,
} from "../../scripts/github/stale-lifecycle.mjs";

const NOW = Date.parse("2026-10-14T12:00:00Z");
const HEAD = "a".repeat(40);
const OLD = "2026-07-01T00:00:00Z";
const WARNING = "2026-08-01T00:00:00Z";
const RECENT = "2026-10-14T10:00:00Z";
const bot = { id: 257215752, type: "Bot", login: "openclaw-barnacle[bot]" };
const human = { id: 123, type: "User", login: "contributor" };
const warningBody =
  "This pull request has been automatically marked as stale due to inactivity.\nPlease add updates or it will be closed.";

function comment(id, body, at = WARNING, user = bot) {
  return {
    id,
    node_id: `comment-${id}`,
    body,
    user,
    created_at: at,
    updated_at: at,
    performed_via_github_app: user === bot ? { id: 2729701 } : null,
  };
}

function snapshot(number = 10) {
  const value = {
    pr: {
      number,
      node_id: `pr-${number}`,
      state: "open",
      merged: false,
      head: { sha: HEAD, ref: "feature", repo: { id: 55 } },
      user: human,
      author_association: "CONTRIBUTOR",
      created_at: OLD,
      updated_at: RECENT,
      labels: [{ name: "stale" }],
      assignees: [],
    },
    comments: [],
    reviews: [],
    reviewComments: [],
    timeline: [],
    runs: [],
    statuses: [],
    checkRollup: "FAILURE",
    workflowRuns: [
      {
        id: 900,
        head_sha: HEAD,
        head_branch: "feature",
        head_repository: { id: 55 },
        event: "pull_request_target",
        created_at: "2026-07-02T00:00:00Z",
      },
    ],
    edits: [],
    lastEditedAt: null,
    ownershipProtection: null,
  };
  value.comments = [comment(1, noticeBody(value.pr))];
  return value;
}

function harness(seed = snapshot(), onComment) {
  const state = structuredClone(seed);
  const writes = [];
  const pages = [];
  let nextId = 200;
  const data = (value) => ({ data: structuredClone(value) });
  const list =
    (endpoint, rows, key) =>
    async ({ page = 1, issue_number }) => {
      pages.push({ endpoint, page });
      const values = rows()
        .slice((page - 1) * 100, page * 100)
        .map((value) =>
          endpoint === "comments" && issue_number
            ? {
                ...value,
                body: value.body.replace(`item=${seed.pr.number} `, `item=${issue_number} `),
              }
            : value,
        );
      return data(key ? { [key]: values } : values);
    };
  const github = {
    rest: {
      rateLimit: {
        get: async () =>
          data({
            resources: {
              core: { remaining: 15000, reset: 1800000000 },
              graphql: { remaining: 5000, reset: 1800000000 },
            },
          }),
      },
      pulls: {
        get: async () => data(state.pr),
        list: list("pulls", () => (state.pr.state === "open" ? [state.pr] : [])),
        listReviewComments: list("review-comments", () => state.reviewComments),
        update: async () => {
          writes.push("close");
          state.pr.state = "closed";
          return data(state.pr);
        },
      },
      issues: {
        get: async () =>
          data({ ...state.pr, closed_by: bot, ...(state.pr.head ? { pull_request: {} } : {}) }),
        listForRepo: list("issues", () => []),
        getLabel: async ({ name }) => data(managedLabelSpecs[name]),
        createLabel: async () => {},
        updateLabel: async () => {},
        update: async ({ state: value, state_reason }) => {
          writes.push("close");
          state.pr.state = value;
          state.pr.state_reason = state_reason;
          state.pr.closed_at = new Date(NOW).toISOString();
          return data(state.pr);
        },
        lock: async () => {
          writes.push("lock");
          state.pr.locked = true;
          return data(state.pr);
        },
        listComments: list("comments", () => state.comments),
        listEventsForTimeline: list("timeline", () => state.timeline),
        createComment: async ({ body }) => {
          writes.push(
            body === closeMessage || body.startsWith("Closing as not planned after")
              ? "close-comment"
              : "warning",
          );
          const created = comment(nextId++, body, new Date(NOW).toISOString());
          state.comments.push(created);
          onComment?.(state);
          return data(created);
        },
        getComment: async ({ comment_id }) =>
          data(state.comments.find((item) => item.id === comment_id)),
        addLabels: async () => {
          writes.push("label");
          return data([]);
        },
        removeLabel: async () => {
          writes.push("unlabel");
          return data({});
        },
      },
      checks: { listForRef: list("checks", () => state.runs, "check_runs") },
      actions: {
        listWorkflowRunsForRepo: list("workflow-runs", () => state.workflowRuns, "workflow_runs"),
      },
      repos: {
        getCollaboratorPermissionLevel: async () => data({ permission: "read", role_name: "read" }),
        listCommitStatusesForRef: list("statuses", () => state.statuses),
      },
      teams: {
        getMembershipForUserInOrg: async () => {
          throw Object.assign(new Error("not a member"), { status: 404 });
        },
      },
    },
    graphql: async (query, variables = {}) => {
      const rateLimit = { remaining: 5000, resetAt: "2027-01-15T08:00:00Z", cost: 1 };
      if (variables.ids || variables.id) {
        const contents = [
          { ...state.pr, lastEditedAt: state.lastEditedAt },
          ...state.comments,
          ...state.reviewComments,
          ...state.reviews,
        ];
        const nodes = (variables.ids ?? [variables.id]).map((id) => {
          const content = contents.find((item) => item.node_id === id || item.id === id);
          if (!content) {
            return null;
          }
          const edits = state.edits
            .filter((edit) => edit.nodeId === id)
            .map((edit, index) => ({ ...edit, id: `${id}-edit-${index}` }))
            .toReversed();
          const start = Number(variables.after ?? 0);
          pages.push({ endpoint: "edits", id, start });
          return {
            id,
            lastEditedAt: content.lastEditedAt ?? edits[0]?.editedAt ?? null,
            userContentEdits: {
              totalCount: edits.length,
              nodes: edits.slice(start, start + 100),
              pageInfo: {
                hasNextPage: edits.length > start + 100,
                endCursor: String(start + 100),
              },
            },
          };
        });
        return { rateLimit, ...(variables.ids ? { nodes } : { node: nodes[0] }) };
      }
      return {
        rateLimit: { remaining: 5000, resetAt: "2027-01-15T08:00:00Z", cost: 1 },
        repository: {
          issue: { id: state.pr.node_id, lastEditedAt: state.lastEditedAt },
          object: { oid: state.pr.head?.sha, statusCheckRollup: { state: state.checkRollup } },
          pullRequest: {
            id: state.pr.node_id,
            lastEditedAt: state.lastEditedAt,
            reviews: {
              nodes: state.reviews.map((review) => ({
                ...review,
                id: review.node_id,
                databaseId: review.id,
              })),
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      };
    },
  };
  const options = {
    github,
    checksGithub: github,
    mutationGithub: github,
    expectedAppId: 2729701,
    includeIssues: !seed.pr.head,
    includePrs: Boolean(seed.pr.head),
    targetKind: seed.pr.head ? "pull-request" : "issue",
    context: { repo: { owner: "example", repo: "project" } },
    core: { info() {}, warning() {} },
    targets: [seed.pr.number],
    now: () => NOW,
  };
  return { state, writes, pages, options };
}

function batchHarness(...members) {
  let active = members[0];
  const github = { rest: {}, graphql: (...args) => active.options.github.graphql(...args) };
  for (const [group, methods] of Object.entries(active.options.github.rest)) {
    github.rest[group] = {};
    for (const method of Object.keys(methods)) {
      github.rest[group][method] = async (params) => {
        if (group === "pulls" && method === "get") {
          active = members.find((member) => member.state.pr.number === params.pull_number);
        }
        return active.options.github.rest[group][method](params);
      };
    }
  }
  github.rest.pulls.list = async () => ({
    data: members.map((member) => structuredClone(member.state.pr)),
  });
  return {
    ...members[0].options,
    github,
    checksGithub: github,
    mutationGithub: github,
    targets: [],
    dryRun: false,
  };
}

function issueSnapshot({ assigned = false, bug = false } = {}) {
  const value = snapshot();
  delete value.pr.head;
  value.pr.assignees = assigned ? [human] : [];
  value.pr.labels = bug ? [{ name: "bug" }] : [];
  value.workflowRuns = [];
  value.comments = [];
  return value;
}

describe("Barnacle unified lifecycle", () => {
  it("executes the pre-token tests with exactly the workflow sparse paths", async () => {
    if (process.env.BARNACLE_SPARSE_PROBE) {
      return;
    }
    const root = new URL("../../", import.meta.url);
    const workflow = await readFile(new URL(".github/workflows/stale.yml", root), "utf8");
    const paths = /sparse-checkout: \|\n((?: {12}[^\n]+\n)+)/
      .exec(workflow)?.[1]
      .trim()
      .split("\n")
      .map((path) => path.trim());
    assert.ok(paths?.length);
    const directory = await mkdtemp(join(tmpdir(), "barnacle-sparse-"));
    try {
      for (const path of paths) {
        const target = join(directory, path);
        await mkdir(join(target, ".."), { recursive: true });
        await cp(new URL(path, root), target, { recursive: true });
      }
      const result = spawnSync(
        process.execPath,
        ["--test", "test/scripts/stale-lifecycle.node.mjs"],
        {
          cwd: directory,
          env: { ...process.env, BARNACLE_SPARSE_PROBE: "1" },
          encoding: "utf8",
          timeout: 30_000,
        },
      );
      assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stderr}\n${result.stdout}`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("response snapshots omit commit/check permissions while retaining review history", async () => {
    const h = harness();
    const queries = [];
    const graphql = h.options.github.graphql;
    h.options.github.graphql = (query, variables) => {
      queries.push({ query, variables });
      return graphql(query, variables);
    };
    await snapshotOf(
      h.options.github,
      h.options.github,
      reader(h.options.github, h.options.github, h.options.context, 4500),
      10,
      "pull-request",
      false,
    );
    const meta = queries.find(({ query }) => query.includes("pullRequest(number:"));
    assert.match(meta.query, /reviews\(first:100/);
    assert.doesNotMatch(meta.query, /object\(oid:|statusCheckRollup|\$head/);
    assert.equal(Object.hasOwn(meta.variables, "head"), false);
    assert.ok(
      h.pages.every(({ endpoint }) => !["checks", "statuses", "workflow-runs"].includes(endpoint)),
    );
  });

  for (const bug of [false, true]) {
    it(`uses the server-created warning time despite client precision and posting delay, bug=${bug}`, async () => {
      const h = harness(issueSnapshot({ bug }));
      const createdAt = "2026-10-14T12:00:04Z";
      const create = h.options.github.rest.issues.createComment;
      h.options.github.rest.issues.createComment = async (params) => {
        const result = await create(params);
        Object.assign(h.state.comments.at(-1), { created_at: createdAt, updated_at: createdAt });
        return { data: structuredClone(h.state.comments.at(-1)) };
      };
      await runStaleLifecycle({ ...h.options, now: () => NOW + 123, dryRun: false });
      const graceEnd = Date.parse(createdAt) + (bug ? 14 : 7) * 86_400_000;
      assert.match(
        h.state.comments[0].body,
        new RegExp(`${bug ? 14 : 7} days after this message was posted`),
      );
      assert.equal(evaluateItem(h.state, graceEnd - 1).reason, "warning-grace");
      assert.equal(evaluateItem(h.state, graceEnd).action, "close");
      await runStaleLifecycle({ ...h.options, now: () => graceEnd - 1, dryRun: false });
      assert.deepEqual(h.writes, ["warning", "label"]);
    });
  }

  for (const label of [
    "enhancement",
    "pinned",
    "clawsweeper:queueable-fix",
    "clawsweeper:source-repro",
    "clawsweeper:fix-shape-clear",
    "impact:security",
    "clawsweeper:needs-security-review",
  ]) {
    for (const kind of ["issue", "pull-request"]) {
      it(`preserves the literal ${kind} label contract: ${label}`, async () => {
        const seed = kind === "issue" ? issueSnapshot() : snapshot();
        seed.pr.labels = [{ name: label }];
        const h = harness(seed);
        const result = await runStaleLifecycle({ ...h.options, dryRun: false });
        if (kind === "pull-request" && label === "enhancement") {
          assert.equal(result.decisions[0].action, "close");
        } else {
          assert.equal(result.decisions[0].reason, "protected-label");
          assert.deepEqual(h.writes, []);
        }
      });
    }
  }

  for (const mutation of [
    "valid",
    "missing",
    "edited",
    "human-reply",
    "short-grace",
    "forged-app",
    "completed",
  ]) {
    it(`audits actual administrative bug closure receipts: ${mutation}`, async () => {
      const seed = issueSnapshot({ bug: true });
      seed.pr.state = "closed";
      seed.pr.state_reason = mutation === "completed" ? "completed" : "not_planned";
      seed.pr.closed_at = new Date(NOW).toISOString();
      const at =
        mutation === "short-grace" ? new Date(NOW - 13 * 86_400_000).toISOString() : WARNING;
      seed.comments = [
        comment(1, noticeBody(seed.pr), at),
        comment(2, closeBody(seed.pr, 1, Date.parse(OLD)), RECENT),
      ];
      seed.timeline = [{ event: "closed", created_at: new Date(NOW).toISOString(), actor: bot }];
      if (mutation === "missing") {
        seed.comments.pop();
      }
      if (mutation === "edited") {
        seed.comments[0].updated_at = RECENT;
      }
      if (mutation === "human-reply") {
        seed.comments.push(comment(3, "still broken", RECENT, human));
      }
      if (mutation === "forged-app") {
        seed.comments[0].performed_via_github_app.id = 1;
      }
      const h = harness(seed);
      h.options.github.rest.issues.listForRepo = async () => ({ data: [h.state.pr] });
      const run = () => auditRecentBugClosures(h.options);
      if (mutation === "valid") {
        assert.deepEqual((await run()).violations, []);
      } else {
        await assert.rejects(run(), /Unauthenticated or premature/);
      }
      assert.deepEqual(h.writes, []);
    });
  }
  for (const label of ["invalid", "r: spam", "r: support"]) {
    for (const mutation of [
      "valid",
      "missing",
      "forged-app",
      "edited",
      "edit-history",
      "cross-item",
      "unknown-rule",
      "wrong-reason",
      "wrong-close-actor",
      "future-receipt",
      "wrong-body",
      "human-receipt",
      "reopened",
      "missing-edit-history",
      "unknown-episode",
      "unstable",
    ]) {
      it(`audits the actual ${label} bug response closure: ${mutation}`, async () => {
        const seed = issueSnapshot({ bug: true });
        seed.pr.labels = [{ name: "bug" }, { name: label }];
        const h = harness(seed);
        await runBarnacleAutoResponse({
          github: h.options.github,
          context: {
            repo: h.options.context.repo,
            payload: { action: "labeled", label: { name: label }, issue: seed.pr },
          },
          expectedAppId: 2729701,
        });
        assert.equal(h.state.pr.state, "closed");
        assert.equal(h.state.comments.length, 1);
        assert.equal(h.state.pr.locked ?? false, label === "r: spam");
        const receipt = h.state.comments[0];
        if (mutation === "missing") {
          h.state.comments = [];
        }
        if (mutation === "forged-app") {
          receipt.performed_via_github_app.id = 1;
        }
        if (mutation === "edited") {
          receipt.updated_at = RECENT;
        }
        if (mutation === "edit-history") {
          h.state.edits.push({
            nodeId: receipt.node_id,
            editedAt: receipt.created_at,
            editor: human,
          });
        }
        if (mutation === "cross-item") {
          receipt.body = receipt.body.replace("item=10 ", "item=999 ");
        }
        if (mutation === "unknown-rule") {
          receipt.body = receipt.body.replace(/rule=[a-f0-9]+/, `rule=${"0".repeat(64)}`);
        }
        if (mutation === "wrong-reason") {
          h.state.pr.state_reason = "completed";
        }
        if (mutation === "wrong-body") {
          receipt.body = `Unexpected preface\n${receipt.body}`;
        }
        if (mutation === "human-receipt") {
          receipt.user = human;
        }
        if (mutation === "reopened") {
          h.state.pr.state = "open";
        }
        if (mutation === "future-receipt") {
          receipt.created_at = receipt.updated_at = new Date(NOW + 1000).toISOString();
        }
        h.state.timeline = [
          { event: "closed", created_at: new Date(NOW).toISOString(), actor: bot },
        ];
        if (mutation === "wrong-close-actor") {
          h.state.timeline[0].actor = { id: 264559031, type: "Bot" };
        }
        if (mutation === "unknown-episode") {
          h.state.timeline.unshift({ event: "reopened", actor: human, created_at: RECENT });
        }
        if (mutation === "missing-edit-history") {
          const graphql = h.options.github.graphql;
          h.options.github.graphql = async (query, variables) =>
            variables.ids
              ? { rateLimit: { remaining: 5000, cost: 1 }, nodes: [null] }
              : graphql(query, variables);
        }
        if (mutation === "unstable") {
          const get = h.options.github.rest.issues.get;
          let reads = 0;
          h.options.github.rest.issues.get = async (...args) => {
            const result = await get(...args);
            if (++reads === 2) {
              result.data.title = "changed during observation";
            }
            return result;
          };
        }
        h.options.github.rest.issues.listForRepo = async () => ({ data: [h.state.pr] });
        const before = h.writes.slice();
        const run = () => auditRecentBugClosures(h.options);
        if (mutation === "valid") {
          assert.deepEqual((await run()).violations, []);
        } else {
          await assert.rejects(run(), /Unauthenticated or premature/);
        }
        assert.deepEqual(h.writes, before);
      });
    }
  }
  it("binds response reuse and the bug audit to the same immutable reopen episode", async () => {
    const seed = issueSnapshot({ bug: true });
    seed.pr.labels = [{ name: "bug" }, { name: "invalid" }];
    const h = harness(seed);
    const options = {
      github: h.options.github,
      context: {
        repo: h.options.context.repo,
        payload: { action: "labeled", label: { name: "invalid" }, issue: seed.pr },
      },
      expectedAppId: 2729701,
    };
    await runBarnacleAutoResponse(options);
    const at = new Date(NOW).toISOString();
    h.state.timeline.push({ id: 500, event: "closed", actor: bot, created_at: at });
    h.state.timeline.push({ id: 501, event: "reopened", actor: human, created_at: at });
    h.state.pr.state = "open";
    const update = h.options.github.rest.issues.update;
    h.options.github.rest.issues.update = async () => {
      throw new Error("close unavailable");
    };
    await assert.rejects(runBarnacleAutoResponse(options), /close unavailable/);
    assert.equal(h.state.comments.length, 2);
    assert.match(h.state.comments[0].body, /episode=initial /);
    assert.match(h.state.comments[1].body, /episode=reopen-501 /);
    h.options.github.rest.issues.update = update;
    await runBarnacleAutoResponse(options);
    assert.equal(h.state.comments.length, 2);
    h.state.timeline.push({ id: 502, event: "closed", actor: bot, created_at: at });
    h.options.github.rest.issues.listForRepo = async () => ({ data: [h.state.pr] });
    assert.deepEqual((await auditRecentBugClosures(h.options)).violations, []);
    h.state.comments.pop();
    await assert.rejects(auditRecentBugClosures(h.options), /Unauthenticated or premature/);
  });
  it("withholds a response when the reopen episode has no immutable identity", async () => {
    const seed = issueSnapshot({ bug: true });
    seed.pr.labels = [{ name: "invalid" }];
    seed.timeline = [{ event: "reopened", created_at: RECENT, actor: human }];
    const h = harness(seed);
    await assert.rejects(
      runBarnacleAutoResponse({
        github: h.options.github,
        context: {
          repo: h.options.context.repo,
          payload: { action: "labeled", label: { name: "invalid" }, issue: seed.pr },
        },
        expectedAppId: 2729701,
      }),
      /Unknown Barnacle response episode/,
    );
    assert.deepEqual(h.writes, []);
  });
  for (const kind of ["issue", "pull-request"]) {
    for (const stage of ["preclose", "prelock"]) {
      for (const mutation of ["edit", "remove"]) {
        it(`withholds ${kind} ${stage} effects after response receipt ${mutation} during observation`, async () => {
          const seed = kind === "issue" ? issueSnapshot() : snapshot();
          seed.pr.labels = [{ name: "r: moltbook" }];
          const at = new Date(NOW).toISOString();
          seed.comments = [comment(1, "Maintainer response pending.", at, human)];
          const h = harness(seed);
          let armed = false;
          const method = stage === "preclose" ? "getComment" : "update";
          const original = h.options.github.rest.issues[method];
          h.options.github.rest.issues[method] = async (params) => {
            const result = await original(params);
            armed = true;
            return result;
          };
          const listComments = h.options.github.rest.issues.listComments;
          h.options.github.rest.issues.listComments = async (params) => {
            if (armed) {
              const receipt = h.state.comments.at(-1);
              if (mutation === "remove") {
                h.state.comments.pop();
              } else {
                // Same-second edit-and-restore leaves exact REST body/timestamps.
                h.state.edits.push({
                  nodeId: receipt.node_id,
                  editedAt: at,
                  editor: { id: human.id, __typename: "User" },
                });
              }
              armed = false;
              h.options.github.rest.issues.listComments = listComments;
            }
            return listComments(params);
          };
          await assert.rejects(
            runBarnacleAutoResponse({
              github: h.options.github,
              context: {
                repo: h.options.context.repo,
                payload: { action: "labeled", label: { name: "r: moltbook" }, issue: seed.pr },
              },
              expectedAppId: 2729701,
            }),
            /changed after notice|changed before lock/,
          );
          assert.deepEqual(h.writes, stage === "prelock" ? ["warning", "close"] : ["warning"]);
          assert.equal(h.state.pr.locked, undefined);
        });
      }
    }
    for (const stage of ["publication", "readback", "prelock"]) {
      it(`withholds ${kind} effects after a same-second reopen during response ${stage}`, async () => {
        const seed = kind === "issue" ? issueSnapshot() : snapshot();
        seed.pr.labels = [{ name: "r: moltbook" }];
        const at = new Date(NOW).toISOString();
        seed.comments = [comment(1, "Maintainer response pending.", at, human)];
        const h = harness(seed);
        const cycle = () => {
          h.state.timeline.push({ id: 500, event: "closed", actor: bot, created_at: at });
          h.state.timeline.push({ id: 501, event: "reopened", actor: human, created_at: at });
          if (stage === "prelock") {
            h.state.timeline.push({ id: 502, event: "closed", actor: bot, created_at: at });
          }
        };
        const method =
          stage === "publication"
            ? "createComment"
            : stage === "readback"
              ? "getComment"
              : "update";
        const original = h.options.github.rest.issues[method];
        h.options.github.rest.issues[method] = async (params) => {
          const result = await original(params);
          cycle();
          h.options.github.rest.issues[method] = original;
          return result;
        };
        await assert.rejects(
          runBarnacleAutoResponse({
            github: h.options.github,
            context: {
              repo: h.options.context.repo,
              payload: { action: "labeled", label: { name: "r: moltbook" }, issue: seed.pr },
            },
            expectedAppId: 2729701,
          }),
          /changed after notice|changed before lock/,
        );
        assert.deepEqual(h.writes, stage === "prelock" ? ["warning", "close"] : ["warning"]);
        assert.equal(h.state.pr.locked, undefined);
      });
    }
  }
  for (const kind of ["pull-request", "issue", "bug"]) {
    for (const assigned of [false, true]) {
      it(`${kind}, assigned=${assigned}: exact inactivity and full grace boundaries`, () => {
        const seed = kind === "pull-request" ? snapshot() : issueSnapshot({ bug: kind === "bug" });
        seed.pr.assignees = assigned ? [human] : [];
        seed.pr.labels = kind === "bug" ? [{ name: "bug" }] : [];
        seed.comments = [];
        seed.workflowRuns = seed.workflowRuns.map((run) => ({ ...run, created_at: OLD }));
        const policy = policyFor(seed.pr);
        assert.equal(policy.inactiveDays, kind === "bug" ? 30 : assigned ? 14 : 7);
        const eligible = Date.parse(OLD) + policy.inactiveDays * 86_400_000;
        assert.equal(evaluateItem(seed, eligible - 1).action, "preserve");
        assert.equal(evaluateItem(seed, eligible).action, "warn");
        const at = new Date(eligible).toISOString();
        seed.comments.push(comment(1, noticeBody(seed.pr), at));
        assert.equal(
          evaluateItem(seed, eligible + policy.graceDays * 86_400_000 - 1).reason,
          "warning-grace",
        );
        assert.equal(evaluateItem(seed, eligible + policy.graceDays * 86_400_000).action, "close");
      });
    }
  }

  for (const bug of [false, true]) {
    it(`legacy issue warning receives one fresh notice and full grace, bug=${bug}`, async () => {
      const seed = issueSnapshot({ bug });
      seed.comments = [comment(1, warningBody)];
      seed.pr.labels.push({ name: "stale" });
      const h = harness(seed);
      await runStaleLifecycle({ ...h.options, dryRun: false });
      await runStaleLifecycle({ ...h.options, dryRun: false });
      assert.deepEqual(h.writes, ["warning", "label"]);
      assert.equal(evaluateItem(h.state, NOW).reason, "warning-grace");
    });

    it(`issue human activity resets but bot churn does not, bug=${bug}`, async () => {
      const seed = issueSnapshot({ bug });
      seed.comments = [comment(1, noticeBody(seed.pr))];
      seed.comments.push(comment(2, "new review", RECENT));
      const h = harness(seed);
      const result = await runStaleLifecycle(h.options);
      assert.equal(result.decisions[0].action, "close");
      seed.comments.push(comment(3, "still reproduces", RECENT, human));
      assert.equal(evaluateItem(seed, NOW).action, "preserve");
      seed.pr.labels.push({ name: "stale" });
      assert.equal(evaluateItem(seed, NOW).action, "unmark");
    });

    it(`issue closure is administrative, verified and replay-safe, bug=${bug}`, async () => {
      const seed = issueSnapshot({ bug });
      seed.comments = [comment(1, noticeBody(seed.pr))];
      const h = harness(seed);
      const result = await runStaleLifecycle({ ...h.options, dryRun: false });
      assert.equal(result.closed, 1);
      assert.equal(h.state.pr.state_reason, "not_planned");
      assert.match(h.state.comments.at(-1).body, /not been confirmed fixed/);
      await runStaleLifecycle({ ...h.options, dryRun: false });
      assert.deepEqual(h.writes, ["close-comment", "close"]);
    });
  }

  for (const change of ["assignment", "bug", "body", "hold"]) {
    it(`changes after the notice invalidate issue closure: ${change}`, async () => {
      const seed = issueSnapshot();
      seed.comments = [comment(1, noticeBody(seed.pr))];
      const h = harness(seed, (state) => {
        if (change === "assignment") {
          state.pr.assignees = [human];
        }
        if (change === "bug") {
          state.pr.labels.push({ name: "bug" });
        }
        if (change === "hold") {
          state.pr.labels.push({ name: "no-stale" });
        }
        if (change === "body") {
          state.lastEditedAt = RECENT;
          state.edits.push({ nodeId: state.pr.node_id, editedAt: RECENT, editor: human });
        }
      });
      await assert.rejects(
        runStaleLifecycle({ ...h.options, dryRun: false }),
        /changed-before-close/,
      );
      assert.deepEqual(h.writes, ["close-comment"]);
    });
  }

  for (const edit of [false, true]) {
    it(`issue human activity on later history pages is complete, edit=${edit}`, async () => {
      const seed = issueSnapshot();
      seed.comments = Array.from({ length: 105 }, (_, id) => comment(id + 2, "bot review", OLD));
      seed.comments.push(comment(200, "still relevant", edit ? OLD : RECENT, human));
      if (edit) {
        seed.comments.at(-1).updated_at = RECENT;
        seed.edits.push({ nodeId: "comment-200", editedAt: RECENT, editor: human });
      }
      const h = harness(seed);
      const result = await runStaleLifecycle({ ...h.options, dryRun: false });
      assert.equal(result.closed, 0);
      assert.deepEqual(h.writes, []);
      assert.ok(h.pages.some((page) => page.endpoint === "comments" && page.page === 2));
    });
  }

  for (const label of [
    "bad-barnacle",
    "no-stale",
    "P0",
    "P1",
    "security",
    "impact:security",
    "clawsweeper:needs-security-review",
  ]) {
    for (const kind of ["issue", "pull-request"]) {
      it(`fresh ${kind} ${label} suppresses every Barnacle effect despite stale payload`, async () => {
        const seed = kind === "issue" ? issueSnapshot() : snapshot();
        seed.pr.labels = [{ name: label }, { name: "trigger-response" }, { name: "invalid" }];
        const h = harness(seed);
        const context = {
          repo: h.options.context.repo,
          payload: {
            action: "labeled",
            label: { name: "invalid" },
            [kind === "issue" ? "issue" : "pull_request"]: {
              ...seed.pr,
              labels: [{ name: "invalid" }],
            },
          },
        };
        await runBarnacleAutoResponse({
          github: h.options.github,
          context,
          expectedAppId: 2729701,
        });
        assert.deepEqual(h.writes, []);
      });
    }
  }

  for (const kind of ["issue", "pull-request"]) {
    for (const surface of ["closure", "reply"]) {
      for (const change of [
        "none",
        "no-stale",
        "bad-barnacle",
        "reason-label",
        "body",
        "ownership",
        ...(kind === "pull-request" ? ["head"] : []),
      ]) {
        it(`${kind} ${surface} publication re-admits after page two: ${change}`, async () => {
          const seed = kind === "issue" ? issueSnapshot() : snapshot();
          seed.pr.title = "Fix a gateway delivery regression";
          seed.pr.body =
            "## What Problem This Solves\n\nA gateway reply was lost.\n\n## Evidence\n\nRegression coverage reproduces the lost reply.";
          seed.pr.labels = [{ name: "r: moltbook" }];
          seed.comments = Array.from({ length: 101 }, (_, id) =>
            comment(id + 1, "Automated review note", OLD),
          );
          const h = harness(seed);
          h.options.github.paginate = async () => [
            { filename: "src/gateway/delivery.ts", status: "modified" },
            { filename: "test/gateway-delivery.test.ts", status: "modified" },
          ];
          const permission = h.options.github.rest.repos.getCollaboratorPermissionLevel;
          h.options.github.rest.repos.getCollaboratorPermissionLevel = async (params) =>
            params.username === "new-owner"
              ? { data: { permission: "write", role_name: "write" } }
              : permission(params);
          let lookup = 0;
          let changed = false;
          const list = h.options.github.rest.issues.listComments;
          h.options.github.rest.issues.listComments = async (params) => {
            if (params.page === 1) {
              lookup++;
            }
            const result = await list(params);
            // The closure's initial snapshot already reads comments. Change
            // only the publisher's second page, after its former admission.
            if (params.page === 2 && lookup === (surface === "reply" ? 1 : 2)) {
              changed = true;
              if (["no-stale", "bad-barnacle"].includes(change)) {
                h.state.pr.labels.push({ name: change });
              } else if (change === "reason-label") {
                h.state.pr.labels = [];
              } else if (change === "body") {
                h.state.pr.body += "\nNew human context.";
              } else if (change === "head") {
                h.state.pr.head.sha = "b".repeat(40);
              } else if (change === "ownership") {
                h.state.pr.assignees = [{ id: 456, login: "new-owner", type: "User" }];
              }
            }
            return result;
          };
          const payload = {
            action: "labeled",
            label: { name: "r: moltbook" },
            [kind === "issue" ? "issue" : "pull_request"]: seed.pr,
            ...(surface === "reply" ? { comment: { id: 500, body: "moltbook", user: human } } : {}),
          };
          const options = {
            github: h.options.github,
            context: { repo: h.options.context.repo, payload },
            expectedAppId: 2729701,
          };
          let failure;
          await runBarnacleAutoResponse(options).catch((error) => {
            failure = error;
          });
          assert.equal(changed, true);
          if (change === "none") {
            assert.equal(failure, undefined);
            assert.deepEqual(
              h.writes,
              surface === "reply" ? ["warning"] : ["warning", "close", "lock"],
            );
            await runBarnacleAutoResponse(options);
            assert.equal(h.state.comments.length, 102);
            assert.equal(h.writes.filter((write) => write === "warning").length, 1);
          } else {
            assert.deepEqual(h.writes, []);
            assert.equal(h.state.comments.length, 101);
            assert.equal(h.state.pr.state, "open");
            assert.equal(h.state.pr.locked, undefined);
            if (failure) {
              assert.match(failure.message, /changed during response admission/);
            }
          }
        });
      }
    }
  }

  for (const failure of ["accepted-comment", "readback", "hold"]) {
    it(`response ${failure} never closes unverified and reconciles a receipt`, async () => {
      const seed = issueSnapshot();
      seed.pr.labels = [{ name: "invalid" }];
      const h = harness(seed);
      const create = h.options.github.rest.issues.createComment;
      const read = h.options.github.rest.issues.getComment;
      if (failure === "accepted-comment") {
        h.options.github.rest.issues.createComment = async (params) => {
          await create(params);
          throw new Error("connection lost");
        };
      }
      if (failure === "readback") {
        h.options.github.rest.issues.getComment = async (params) => {
          const result = await read(params);
          result.data.body = "mismatch";
          return result;
        };
      }
      if (failure === "hold") {
        h.options.github.rest.issues.createComment = async (params) => {
          const result = await create(params);
          h.state.pr.labels.push({ name: "no-stale" });
          return result;
        };
      }
      const options = {
        github: h.options.github,
        context: {
          repo: h.options.context.repo,
          payload: { action: "labeled", label: { name: "invalid" }, issue: seed.pr },
        },
        expectedAppId: 2729701,
      };
      await assert.rejects(
        runBarnacleAutoResponse(options),
        /connection lost|readback mismatch|changed/,
      );
      assert.equal(h.state.pr.state, "open");
      if (failure !== "hold") {
        h.options.github.rest.issues.createComment = create;
        h.options.github.rest.issues.getComment = read;
        await runBarnacleAutoResponse(options);
        assert.equal(h.state.pr.state, "closed");
        assert.equal(h.state.comments.length, 1);
      }
    });
  }
});

describe("Barnacle PR inactivity", () => {
  // Keep these REST contract values independent of the production event set.
  for (const event of [
    "renamed",
    "reopened",
    "convert_to_draft",
    "ready_for_review",
    "review_requested",
    "review_dismissed",
    "assigned",
    "unassigned",
    "labeled",
    "unlabeled",
    "base_ref_changed",
  ]) {
    for (const actor of [human, bot]) {
      it(`attributes REST ${event} activity to ${actor.type}`, () => {
        const seed = snapshot();
        seed.timeline = [{ id: 901, event, actor, created_at: RECENT }];
        assert.equal(evaluateItem(seed, NOW).action, actor === human ? "unmark" : "close");
      });
    }
  }

  for (const [oldUser, oldApp, newUser, newApp] of [
    [257215752, 2729701, 264559031, 2971289],
    [264559031, 2971289, 257215752, 2729701],
  ]) {
    it(`reuses an authenticated close receipt across app failover ${oldApp} to ${newApp}`, async () => {
      const seed = snapshot();
      seed.comments.push({
        ...comment(99, closeMessage, RECENT),
        user: { id: oldUser, type: "Bot" },
        performed_via_github_app: { id: oldApp },
      });
      const h = harness(seed);
      h.options.github.rest.issues.get = async () => ({ data: { closed_by: { id: newUser } } });
      const result = await runStaleLifecycle({
        ...h.options,
        expectedAppId: newApp,
        dryRun: false,
      });
      assert.equal(result.closed, 1);
      assert.deepEqual(h.writes, ["close"]);
    });
  }

  it("rejects an unexpected app on a newly posted close receipt", async () => {
    const h = harness();
    await assert.rejects(
      runStaleLifecycle({ ...h.options, expectedAppId: 2971289, dryRun: false }),
      /Close comment readback mismatch/,
    );
    assert.deepEqual(h.writes, ["close-comment"]);
  });

  for (const user of [human, bot]) {
    it(`never reuses an unauthenticated ${user.type} close receipt`, () => {
      const seed = snapshot();
      seed.comments.push({
        ...comment(99, closeMessage, OLD, user),
        performed_via_github_app: { id: 1 },
      });
      assert.equal(evaluateItem(seed, NOW).closeComment, undefined);
    });
  }

  it("rejects human copies and mismatched app identities as warning authority", () => {
    for (const copied of [human, bot]) {
      const seed = snapshot();
      seed.workflowRuns = [];
      seed.comments = [comment(8, noticeBody(seed.pr), "2026-10-06T12:00:00Z", copied)];
      seed.comments[0].performed_via_github_app = copied === bot ? { id: 123 } : null;
      assert.equal(evaluateItem(seed, NOW).action, "preserve");
    }
    const seed = snapshot();
    seed.comments.push(comment(9, closeMessage, RECENT, human));
    assert.equal(evaluateItem(seed, NOW).action, "unmark");
  });

  for (const missing of ["repo", "branch"]) {
    it(`rejects a legacy witness missing source ${missing}`, () => {
      const seed = snapshot();
      seed.comments = [comment(1, warningBody)];
      if (missing === "repo") {
        delete seed.pr.head.repo.id;
        delete seed.workflowRuns[0].head_repository.id;
      } else {
        delete seed.pr.head.ref;
        delete seed.workflowRuns[0].head_branch;
      }
      assert.equal(evaluateItem(seed, NOW).reason, "unknown-head-timing");
    });
  }

  it("requires aggregate success for a product job but accepts a true gate independently", () => {
    const seed = snapshot();
    seed.runs = [
      { head_sha: HEAD, name: "build-artifacts", status: "completed", conclusion: "success" },
    ];
    assert.equal(evaluateItem(seed, NOW).action, "close");
    seed.checkRollup = "SUCCESS";
    assert.equal(evaluateItem(seed, NOW).reason, "executed-ci-proof");
    seed.checkRollup = "FAILURE";
    seed.runs.push({
      head_sha: HEAD,
      name: "openclaw/ci-gate",
      status: "completed",
      conclusion: "success",
    });
    assert.equal(evaluateItem(seed, NOW).reason, "executed-ci-proof");
    seed.checkRollup = "SUCCESS";
    seed.runs = [{ head_sha: HEAD, name: "metadata", status: "completed", conclusion: "success" }];
    assert.equal(evaluateItem(seed, NOW).action, "close");
  });

  it("routes all mutations to Barnacle and GraphQL/checks only to the checks reader", async () => {
    for (const action of ["close", "warn", "unmark"]) {
      const seed = snapshot();
      if (action === "warn") {
        seed.comments = [];
      }
      if (action === "unmark") {
        seed.comments.push(comment(999, "response", RECENT, human));
      }
      const h = harness(seed);
      const app = h.options.github;
      const writer = { rest: { issues: { ...app.rest.issues }, pulls: { ...app.rest.pulls } } };
      const checks = {
        rest: { checks: app.rest.checks, rateLimit: app.rest.rateLimit },
        graphql: app.graphql,
      };
      const denied = async () => {
        throw new Error("wrong client");
      };
      for (const method of ["createComment", "addLabels", "removeLabel"]) {
        app.rest.issues[method] = denied;
      }
      app.rest.pulls.update = denied;
      app.rest.checks = { listForRef: denied };
      app.graphql = denied;
      await runStaleLifecycle({
        ...h.options,
        checksGithub: checks,
        mutationGithub: writer,
        dryRun: false,
      });
      assert.deepEqual(
        h.writes,
        action === "close"
          ? ["close-comment", "close"]
          : action === "warn"
            ? ["warning", "label"]
            : ["unlabel"],
      );
    }
  });

  it("reserves terminal reads before effects at the shared 4500-request boundary", async () => {
    const h = harness();
    const states = new Map(
      Array.from({ length: 404 }, (_, index) => [index + 1, snapshot(index + 1).pr]),
    );
    let active;
    h.options.github.rest.pulls.get = async ({ pull_number }) => {
      active = pull_number;
      return { data: structuredClone(states.get(pull_number)) };
    };
    h.options.github.rest.pulls.update = async ({ pull_number }) => {
      h.writes.push("close");
      const pr = states.get(pull_number);
      pr.state = "closed";
      return { data: structuredClone(pr) };
    };
    h.options.github.rest.checks.listForRef = async () => ({
      data: {
        check_runs:
          active < 404
            ? [
                {
                  head_sha: HEAD,
                  name: "openclaw/ci-gate",
                  status: "completed",
                  conclusion: "success",
                },
              ]
            : [],
      },
    });
    h.options.github.rest.issues.listComments = async ({ issue_number, page }) => {
      const comments =
        issue_number === 1
          ? Array.from({ length: 700 }, (_, id) => comment(id + 1, warningBody))
          : h.state.comments.map((comment) => ({
              ...comment,
              body: comment.body.replace("item=10 ", `item=${issue_number} `),
            }));
      return { data: structuredClone(comments.slice((page - 1) * 100, page * 100)) };
    };
    const result = await runStaleLifecycle({
      ...h.options,
      targets: [...states.keys()],
      dryRun: false,
    });
    assert.equal(result.exhausted, true);
    assert.equal(result.considered, 403);
    assert.equal(result.closed, 0);
    assert.equal(
      result.requests,
      4491,
      "reserve rejects effects before the final read would exceed 4500",
    );
    assert.deepEqual(h.writes, []);
    const retry = await runStaleLifecycle({ ...h.options, targets: [404], dryRun: false });
    assert.equal(retry.closed, 1);
    assert.deepEqual(h.writes, ["close-comment", "close"]);
  });

  it("reports a confirmed close when terminal verification fails instead of forgetting it", async () => {
    const h = harness();
    const logs = [];
    h.options.core.info = (line) => logs.push(line);
    h.options.github.rest.issues.get = async () => {
      throw new Error("read unavailable");
    };
    await assert.rejects(
      runStaleLifecycle({ ...h.options, dryRun: false }),
      /Unfinished PR mutation.*"closed":true/,
    );
    assert.ok(
      logs.some((line) => line.includes('"closed":1') && line.includes('"unfinished":true')),
    );
    assert.deepEqual(h.writes, ["close-comment", "close"]);
  });

  it("stops on actual token quota with no effects and no silent credential substitution", async () => {
    const h = harness();
    let calls = 0;
    h.options.github.rest.rateLimit.get = async () => ({
      data: {
        resources: {
          core: { remaining: ++calls === 1 ? 15000 : 12, reset: 1800000000 },
          graphql: { remaining: 1000, reset: 1800000000 },
        },
      },
    });
    const result = await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.equal(result.exhausted, true);
    assert.equal(result.closed, 0);
    assert.deepEqual(h.writes, []);
    await assert.rejects(
      runStaleLifecycle({ ...h.options, mutationGithub: undefined, dryRun: false }),
      /Explicit app reader/,
    );
  });

  it("keeps the generic issue backfill inside the remaining shared cap", async () => {
    const h = harness();
    const result = await runStaleLifecycle({ ...h.options, dryRun: false, maxClosures: 2 });
    assert.equal(result.remainingClosures, 1);
    const yaml = await readFile(
      new URL("../../.github/workflows/stale.yml", import.meta.url),
      "utf8",
    );
    assert.match(yaml, /runStaleLifecycle/);
    assert.doesNotMatch(yaml, /actions\/stale|backfill-stale-closures:/);
    const zero = await runStaleLifecycle({ ...h.options, maxClosures: 0 });
    assert.equal(zero.remainingClosures, 0);
  });
  it("closes an expired lost-label warning despite later bot comment and rating churn", async () => {
    const seed = snapshot();
    assert.ok(
      Date.parse(seed.pr.updated_at) > NOW - 7 * 86_400_000,
      "old raw updated_at close gate rejects this fixture",
    );
    seed.pr.labels = [];
    seed.comments.push(
      comment(2, "review refreshed", RECENT, { id: 274271284, type: "Bot", login: "reviewer" }),
    );
    const h = harness(seed);
    const dry = await runStaleLifecycle(h.options);
    assert.partialDeepStrictEqual(dry.decisions[0], {
      action: "close",
      reason: "expired-warning",
      witness: "warning-head",
    });
    assert.deepEqual(h.writes, []);
    const live = await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.equal(live.closed, 1);
    assert.deepEqual(h.writes, ["close-comment", "close"]);
    assert.equal(
      h.state.comments.at(-1)?.body,
      "Closing due to inactivity.\nIf you believe this PR should be revived, post in #clawtributors on Discord to talk to a maintainer.\nThat channel is the escape hatch for high-quality PRs that get auto-closed.\n",
    );
  });

  for (const kind of [
    "comment",
    "comment-edit",
    "review",
    "inline-edit",
    "body-edit",
    "force-push",
  ]) {
    it(`returns recent ${kind} activity to the seven-day inactivity gate`, () => {
      const seed = snapshot();
      if (kind.startsWith("comment")) {
        seed.comments.push(comment(2, "response", kind === "comment" ? RECENT : OLD, human));
      }
      if (kind === "review") {
        seed.reviews.push({
          id: 3,
          author: { __typename: "User" },
          submittedAt: RECENT,
        });
      }
      if (kind === "inline-edit") {
        seed.reviewComments.push({ ...comment(4, "inline", OLD, human), updated_at: RECENT });
      }
      if (["comment-edit", "inline-edit", "body-edit"].includes(kind)) {
        seed.edits.push({ editedAt: RECENT, editor: human });
      }
      if (kind === "force-push") {
        seed.timeline.push({
          event: "head_ref_force_pushed",
          created_at: RECENT,
          actor: { ...human, type: "Bot" },
        });
      }
      assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
        action: "unmark",
        reason: "human-or-head-activity",
        eligibleAt: "2026-10-21T10:00:00.000Z",
      });
    });
  }

  for (const hasWarning of [false, true]) {
    it(`waits seven idle days after an ordinary push, prior warning=${hasWarning}`, () => {
      const seed = snapshot();
      seed.comments = hasWarning
        ? [comment(1, `${warningBody}\n\n<!-- barnacle-stale-pr:v1 head=${"b".repeat(40)} -->`)]
        : [];
      seed.workflowRuns[0].created_at = RECENT;
      assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
        action: "unmark",
        eligibleAt: "2026-10-21T10:00:00.000Z",
      });
      assert.equal(evaluateItem(seed, Date.parse("2026-10-28T10:00:00Z")).action, "warn");
    });
  }

  it("does not accept unrelated SHA existence or embedded historical review dates", () => {
    const seed = snapshot();
    seed.workflowRuns[0].head_repository.id = 99;
    seed.comments = [comment(1, warningBody)];
    assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
      action: "preserve",
      reason: "unknown-head-timing",
    });
    seed.comments = [];
    assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
      action: "preserve",
      reason: "unknown-head-timing",
    });
  });

  it("records actual head in a new warning and preserves the real seven-day grace", async () => {
    const seed = snapshot();
    seed.comments = [];
    seed.pr.labels = [];
    const h = harness(seed);
    await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.deepEqual(h.writes, ["warning", "label"]);
    assert.ok(
      h.state.comments[0].body.includes(
        `<!-- barnacle-stale:v2 item=10 kind=pull-request lane=unassigned head=${HEAD} -->`,
      ),
    );
    assert.partialDeepStrictEqual(evaluateItem(h.state, NOW + 6 * 86_400_000), {
      action: "preserve",
      reason: "warning-grace",
    });
    assert.equal(evaluateItem(h.state, NOW + 7 * 86_400_000).action, "close");
  });

  it("retains a saturated PR's warning, continues the scan, and does not warn twice", async () => {
    const seed = snapshot();
    seed.comments = [];
    seed.pr.labels = Array.from({ length: 100 }, (_, i) => ({ name: `label-${i}` }));
    const h = harness(seed);
    const logs = [];
    h.options.github.rest.issues.addLabels = async () => {
      h.writes.push("label");
      throw Object.assign(new Error("Validation Failed. Issues cannot have more than 100 labels"), {
        status: 422,
      });
    };
    const options = {
      ...h.options,
      targets: [10, 11],
      dryRun: false,
      core: { info: (line) => logs.push(line), warning() {} },
    };
    const first = await runStaleLifecycle(options);
    assert.equal(first.considered, 2);
    assert.equal(first.unfinished, false);
    assert.partialDeepStrictEqual(first.decisions[0], {
      number: 10,
      action: "warn",
      reason: "label-capacity",
      commentId: 200,
    });
    assert.ok(logs.some((line) => line.includes('"reason":"label-capacity"')));
    assert.equal(h.state.comments.length, 1);
    assert.deepEqual(h.state.pr.labels, seed.pr.labels);
    await runStaleLifecycle(options);
    assert.deepEqual(h.writes, ["warning", "label"]);
  });

  it("still fails for other label validation errors", async () => {
    const seed = snapshot();
    seed.comments = [];
    const h = harness(seed);
    h.options.github.rest.issues.addLabels = async () => {
      throw Object.assign(new Error("Validation Failed: invalid label"), { status: 422 });
    };
    await assert.rejects(
      runStaleLifecycle({ ...h.options, dryRun: false }),
      /Unfinished PR mutation.*invalid label/,
    );
  });

  for (const witness of ["review", "workflow-run"]) {
    it(`retains an eight-day bound warning despite a recent bot ${witness}`, () => {
      const seed = snapshot();
      seed.comments = [comment(1, noticeBody(seed.pr), "2026-10-06T12:00:00Z")];
      seed.workflowRuns = [];
      if (witness === "review") {
        seed.reviews.push({ id: 3, author: bot, commit_id: HEAD, submittedAt: RECENT });
      } else {
        seed.workflowRuns = [{ ...snapshot().workflowRuns[0], created_at: RECENT }];
      }
      assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
        action: "close",
        reason: "expired-warning",
        witness: "warning-head",
      });
      seed.timeline.push({ event: "head_ref_force_pushed", actor: bot, created_at: RECENT });
      assert.equal(evaluateItem(seed, NOW).action, "unmark");
      seed.timeline = [];
      seed.comments.push(comment(2, "working on it", RECENT, human));
      assert.equal(evaluateItem(seed, NOW).action, "unmark");
    });
  }

  it("does not use an edited warning as a head witness", () => {
    const seed = snapshot();
    seed.comments[0].body = noticeBody(seed.pr);
    seed.comments[0].updated_at = RECENT;
    seed.workflowRuns = [];
    assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
      action: "preserve",
      reason: "unknown-head-timing",
    });
  });

  it("closes at seven days plus one millisecond with only a bound warning and new bot review", () => {
    const seed = snapshot();
    seed.comments = [
      comment(1, noticeBody(seed.pr), new Date(NOW - 7 * 86_400_000 - 1).toISOString()),
    ];
    seed.workflowRuns = [];
    seed.reviews = [{ id: 3, author: bot, commit_id: HEAD, submittedAt: RECENT }];
    assert.equal(evaluateItem(seed, NOW).action, "close");
  });

  for (const kind of ["reply", "force-push"]) {
    it(`counts a real ${kind} in the warning's timestamp second`, () => {
      const seed = snapshot();
      const at = "2026-10-10T12:00:00Z";
      seed.comments = [comment(1, noticeBody(seed.pr), at)];
      seed.workflowRuns = [];
      if (kind === "reply") {
        seed.comments.push(comment(2, "responding", at, human));
      } else {
        seed.timeline.push({ event: "head_ref_force_pushed", created_at: at, actor: bot });
      }
      assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
        action: "unmark",
        reason: "human-or-head-activity",
        eligibleAt: "2026-10-17T12:00:00.000Z",
      });
    });
  }

  for (const editor of [bot, human]) {
    it(`rejects a bound warning edited by ${editor.type} within its creation second`, async () => {
      const seed = snapshot();
      seed.workflowRuns = [];
      seed.comments[0].body = noticeBody(seed.pr);
      seed.edits.push({ nodeId: "comment-1", commentId: 1, editedAt: WARNING, editor });
      const h = harness(seed);
      const result = await runStaleLifecycle(h.options);
      assert.partialDeepStrictEqual(result.decisions[0], {
        action: "preserve",
        reason: "unknown-head-timing",
      });
    });
  }

  for (const surface of ["body", "comment", "review", "inline"]) {
    for (const humanEdit of [false, true]) {
      it(`attributes ${surface} edits to actual editors, human edit=${humanEdit}`, async () => {
        const seed = snapshot();
        let nodeId;
        if (surface === "body") {
          nodeId = seed.pr.node_id;
          seed.lastEditedAt = RECENT;
        } else if (surface === "review") {
          nodeId = "review-3";
          seed.reviews.push({
            id: 3,
            node_id: nodeId,
            author: humanEdit ? bot : human,
            submittedAt: OLD,
            lastEditedAt: RECENT,
            commit: { oid: HEAD },
          });
        } else {
          const content = {
            ...comment(3, "old content", OLD, humanEdit ? bot : human),
            updated_at: RECENT,
          };
          nodeId = content.node_id;
          (surface === "comment" ? seed.comments : seed.reviewComments).push(content);
        }
        // A subsequent bot edit must not hide an earlier human edit.
        if (humanEdit) {
          seed.edits.push({ nodeId, editedAt: "2026-10-13T10:00:00Z", editor: human });
        }
        seed.edits.push({ nodeId, editedAt: RECENT, editor: bot });
        const h = harness(seed);
        const result = await runStaleLifecycle(h.options);
        assert.equal(result.decisions[0].action, humanEdit ? "unmark" : "close");
        assert.equal(
          h.pages.filter((page) => page.endpoint === "edits" && page.id === nodeId).length,
          1,
        );
        assert.deepEqual(h.writes, []);
      });
    }
  }

  it("paginates all edits and retains a human edit behind newer bot edits", async () => {
    const seed = snapshot();
    seed.comments.push({ ...comment(3, "review", OLD), updated_at: RECENT });
    seed.edits = [
      { nodeId: "comment-3", editedAt: "2026-10-13T10:00:00Z", editor: human },
      ...Array.from({ length: 100 }, () => ({
        nodeId: "comment-3",
        editedAt: RECENT,
        editor: bot,
      })),
    ];
    const h = harness(seed);
    const result = await runStaleLifecycle(h.options);
    assert.equal(result.decisions[0].action, "unmark");
    assert.ok(h.pages.some((page) => page.endpoint === "edits" && page.start === 100));
  });

  for (const missing of ["editor", "node", "page", "latest", "duplicate"]) {
    it(`preserves missing ${missing} edit evidence`, async () => {
      const seed = snapshot();
      seed.lastEditedAt = RECENT;
      seed.edits.push({ nodeId: seed.pr.node_id, editedAt: RECENT, editor: bot });
      const h = harness(seed);
      const graphql = h.options.github.graphql;
      h.options.github.graphql = async (query, variables) => {
        const result = await graphql(query, variables);
        if (result.nodes) {
          if (missing === "node") {
            result.nodes[0] = null;
          }
          if (missing === "editor") {
            result.nodes[0].userContentEdits.nodes[0].editor = null;
          }
          if (missing === "page") {
            result.nodes[0].userContentEdits.pageInfo.endCursor = null;
          }
          if (missing === "page") {
            result.nodes[0].userContentEdits.pageInfo.hasNextPage = true;
          }
          if (missing === "latest") {
            result.nodes[0].lastEditedAt = "2026-10-14T11:00:00Z";
          }
          if (missing === "duplicate") {
            result.nodes[0].userContentEdits.nodes.push(result.nodes[0].userContentEdits.nodes[0]);
            result.nodes[0].userContentEdits.totalCount++;
          }
        }
        return result;
      };
      const result = await runStaleLifecycle({ ...h.options, dryRun: false });
      assert.equal(result.decisions[0].action, "preserve");
      assert.match(result.decisions[0].reason, /edit/);
      assert.equal(result.unfinished, false);
      assert.deepEqual(h.writes, []);
    });
  }

  it("assigned PRs use fourteen days of human inactivity, not creation age", () => {
    const seed = snapshot();
    seed.comments = [comment(2, "still working", RECENT, human)];
    seed.pr.assignees = [human];
    assert.equal(evaluateItem(seed, NOW).action, "unmark");
    seed.pr.labels = [];
    seed.comments = [];
    assert.equal(evaluateItem(seed, NOW).action, "warn");
    seed.ownershipProtection = "maintainer-ownership";
    assert.equal(evaluateItem(seed, NOW).action, "preserve");
  });

  for (const name of [
    "security",
    "P1",
    "P0",
    "no-stale",
    "bad-barnacle",
    "maintainer",
    "status: 👀 ready for maintainer look",
  ]) {
    it(`preserves ${name}`, () => {
      const seed = snapshot();
      seed.pr.labels.push({ name });
      assert.partialDeepStrictEqual(evaluateItem(seed, NOW), {
        action: "preserve",
        reason: "protected-label",
      });
    });
  }

  it("finds an older exact-head required gate on the second latest-check page", async () => {
    const seed = snapshot();
    seed.runs = Array.from({ length: 100 }, (_, id) => ({
      id,
      head_sha: HEAD,
      name: "metadata",
      status: "completed",
      conclusion: "failure",
    }));
    seed.runs.push({
      head_sha: HEAD,
      name: "openclaw/ci-gate",
      status: "completed",
      conclusion: "success",
    });
    const h = harness(seed);
    const result = await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.equal(result.decisions[0].reason, "executed-ci-proof");
    assert.deepEqual(h.writes, []);
    assert.ok(h.pages.some((item) => isDeepStrictEqual(item, { endpoint: "checks", page: 2 })));
  });

  it("does not mistake successful metadata or skipped product jobs for proof", () => {
    const seed = snapshot();
    seed.runs = [
      { head_sha: HEAD, name: "plan", status: "completed", conclusion: "success" },
      { head_sha: HEAD, name: "tests", status: "completed", conclusion: "skipped" },
    ];
    assert.equal(evaluateItem(seed, NOW).action, "close");
  });

  for (const name of [
    "CI gate",
    "ci-gate",
    "checks-node-core",
    "check",
    "build-smoke",
    "build-artifacts",
  ]) {
    it(`preserves executed historical ${name} proof`, () => {
      const seed = snapshot();
      seed.checkRollup = "SUCCESS";
      seed.runs = [{ head_sha: HEAD, name, status: "completed", conclusion: "success" }];
      assert.equal(evaluateItem(seed, NOW).reason, "executed-ci-proof");
    });
  }

  it("uses the latest status for each named context", () => {
    const seed = snapshot();
    seed.statuses = [
      { context: "openclaw/ci-gate", state: "failure" },
      { context: "openclaw/ci-gate", state: "success" },
    ];
    assert.equal(evaluateItem(seed, NOW).action, "close");
    seed.statuses.reverse();
    assert.equal(evaluateItem(seed, NOW).reason, "executed-ci-proof");
  });

  it("distinguishes trusted security markers from ordinary blocked verdicts", () => {
    const seed = snapshot();
    const review = {
      ...comment(
        8,
        `<!-- clawsweeper-verdict:needs-human item=10 sha=${HEAD} -->\n<!-- clawsweeper-review-state:blocked item=10 sha=${HEAD} -->`,
        OLD,
        { id: 274271284, type: "Bot", login: "reviewer" },
      ),
      performed_via_github_app: { id: 3306130 },
    };
    seed.comments.push(review);
    assert.equal(evaluateItem(seed, NOW).action, "close");
    review.body += `\n<!-- clawsweeper-security:security-sensitive item=10 sha=${HEAD} confidence=high -->`;
    assert.equal(evaluateItem(seed, NOW).reason, "security-review-required");
    review.body = review.body.replace(
      `security-sensitive item=10 sha=${HEAD}`,
      `security-sensitive item=10 sha=${"b".repeat(40)}`,
    );
    assert.equal(evaluateItem(seed, NOW).reason, "unknown-security-head");
    review.body = review.body.replace("security-sensitive item=10", "security-sensitive item=11");
    assert.equal(evaluateItem(seed, NOW).action, "close");
  });

  for (const kind of ["human", "head", "assignment"]) {
    it(`revalidates a ${kind} race after posting the close comment`, async () => {
      const h = harness(snapshot(), (state) => {
        if (kind === "human") {
          state.comments.push(comment(999, "working on this", RECENT, human));
        }
        if (kind === "head") {
          state.pr.head.sha = "b".repeat(40);
        }
        if (kind === "assignment") {
          state.ownershipProtection = "maintainer-ownership";
        }
      });
      if (kind === "assignment") {
        h.options.github.rest.repos.getCollaboratorPermissionLevel = async () => ({
          data: { permission: h.state.ownershipProtection ? "write" : "read", role_name: "read" },
        });
      }
      await assert.rejects(
        runStaleLifecycle({ ...h.options, dryRun: false }),
        /Unfinished PR mutation.*"commentId":200.*changed-before-close/,
      );
      assert.deepEqual(h.writes, ["close-comment"]);
    });
  }

  for (const kind of ["pull-request", "issue", "bug"]) {
    for (const mutation of ["remove", "body-edit", "history-edit", "replace"]) {
      it(`revalidates the selected ${kind} inactivity receipt after final observation ${mutation}`, async () => {
        const seed = kind === "pull-request" ? snapshot() : issueSnapshot({ bug: kind === "bug" });
        seed.comments = [comment(1, noticeBody(seed.pr))];
        const h = harness(seed);
        let armed = false;
        const getComment = h.options.github.rest.issues.getComment;
        h.options.github.rest.issues.getComment = async (params) => {
          const result = await getComment(params);
          armed = true;
          return result;
        };
        const listComments = h.options.github.rest.issues.listComments;
        h.options.github.rest.issues.listComments = async (params) => {
          if (armed) {
            const receipt = h.state.comments.at(-1);
            if (mutation === "remove") {
              h.state.comments.pop();
            } else if (mutation === "replace") {
              Object.assign(receipt, { id: 999, node_id: "comment-999" });
            } else if (mutation === "body-edit") {
              receipt.body = "Edited by automation.";
            } else {
              h.state.edits.push({
                nodeId: receipt.node_id,
                editedAt: receipt.created_at,
                editor: bot,
              });
            }
            h.options.github.rest.issues.listComments = listComments;
          }
          return listComments(params);
        };
        await assert.rejects(
          runStaleLifecycle({ ...h.options, dryRun: false }),
          /Unfinished PR mutation.*"commentId":200.*changed-before-close/,
        );
        assert.deepEqual(h.writes, ["close-comment"]);
        assert.equal(h.state.pr.state, "open");
        // A new scan can admit a replacement or create a fresh receipt safely.
        await runStaleLifecycle({ ...h.options, dryRun: false });
        assert.deepEqual(
          h.writes,
          mutation === "replace"
            ? ["close-comment", "close"]
            : ["close-comment", "close-comment", "close"],
        );
      });
    }
  }

  it("preserves incomplete filtered workflow history", async () => {
    const h = harness();
    h.options.github.rest.actions.listWorkflowRunsForRepo = async () => ({
      data: { workflow_runs: [], total_count: 1001 },
    });
    const result = await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.equal(result.decisions[0].reason, "incomplete-workflow-history");
    assert.deepEqual(h.writes, []);
  });

  it("reuses a verified interrupted closure comment without duplicating it", async () => {
    const seed = snapshot();
    seed.comments.push(comment(99, closeMessage, RECENT));
    const h = harness(seed);
    await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.deepEqual(h.writes, ["close"]);
  });

  for (const editor of [bot, human]) {
    it(`counts actual ${editor.type} edits to an exact-body reused close receipt`, async () => {
      const seed = snapshot();
      seed.comments.push(comment(99, closeMessage, RECENT));
      seed.edits.push({ nodeId: "comment-99", editedAt: RECENT, editor });
      const h = harness(seed);
      await runStaleLifecycle({ ...h.options, dryRun: false });
      assert.deepEqual(h.writes, editor === human ? ["unlabel"] : ["close-comment", "close"]);
    });
  }

  it("retains a new receipt when a human edits it within its creation second", async () => {
    const h = harness(snapshot(), (state) => {
      const receipt = state.comments.at(-1);
      state.edits.push({ nodeId: receipt.node_id, editedAt: receipt.created_at, editor: human });
    });
    await assert.rejects(
      runStaleLifecycle({ ...h.options, dryRun: false }),
      /Unfinished PR mutation.*"commentId":200.*changed-before-close/,
    );
    assert.deepEqual(h.writes, ["close-comment"]);
  });

  it("preserves a security exemption arriving after its close comment", async () => {
    const h = harness(snapshot(), (state) => state.pr.labels.push({ name: "security" }));
    await assert.rejects(
      runStaleLifecycle({ ...h.options, dryRun: false }),
      /Unfinished PR mutation.*"commentId":200.*changed-before-close/,
    );
    assert.deepEqual(h.writes, ["close-comment"]);
  });

  it("keeps post-warning receipts and checkpoints before an unfinished target", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stale-pr-test-"));
    try {
      const seed = snapshot(11);
      seed.comments = [];
      const h = harness(seed, (state) =>
        state.comments.push(comment(999, "author response", new Date(NOW).toISOString(), human)),
      );
      const cursorPath = join(dir, "cursor");
      const logs = [];
      const outputs = [];
      h.options.core.setOutput = (...output) => outputs.push(output);
      h.options.core.info = (line) => logs.push(line);
      h.options.github.rest.pulls.list = async () => ({
        data: [snapshot(10).pr, seed.pr, snapshot(12).pr],
      });
      let active;
      h.options.github.rest.pulls.get = async ({ pull_number }) => {
        active = pull_number;
        return { data: { ...structuredClone(h.state.pr), number: pull_number } };
      };
      h.options.github.rest.checks.listForRef = async () => ({
        data: {
          check_runs:
            active === 10
              ? [
                  {
                    head_sha: HEAD,
                    name: "openclaw/ci-gate",
                    status: "completed",
                    conclusion: "success",
                  },
                ]
              : [],
        },
      });
      h.options.core.error = (line) => logs.push(line);
      await assert.rejects(
        runStaleLifecycle({
          ...h.options,
          targets: [],
          dryRun: false,
          cursorPath,
        }),
        /Unfinished PR mutation.*"commentId":200.*changed-after-warning/,
      );
      assert.deepEqual(h.writes, ["warning"]);
      assert.deepEqual(JSON.parse(await readFile(cursorPath, "utf8")), { lastNumber: 10 });
      assert.ok(logs.some((line) => line.includes('"number":10')));
      assert.ok(logs.some((line) => line.includes('"commentId":200')));
      assert.ok(logs.some((line) => line.includes('"unfinished":true')));
      assert.deepEqual(outputs, [["checkpoint-written", "true"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retains earlier confirmed closes when a later close comment hits a race", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stale-pr-test-"));
    try {
      const first = harness(snapshot(10));
      const second = harness(snapshot(11), (state) => state.pr.labels.push({ name: "security" }));
      let active = first;
      const github = { rest: {}, graphql: (...args) => active.options.github.graphql(...args) };
      for (const [group, methods] of Object.entries(first.options.github.rest)) {
        github.rest[group] = {};
        for (const method of Object.keys(methods)) {
          github.rest[group][method] = async (params) => {
            if (group === "pulls" && method === "get") {
              active = params.pull_number === 10 ? first : second;
            }
            return active.options.github.rest[group][method](params);
          };
        }
      }
      github.rest.pulls.list = async () => ({ data: [first.state.pr, second.state.pr] });
      const logs = [];
      const cursorPath = join(dir, "cursor");
      await assert.rejects(
        runStaleLifecycle({
          ...first.options,
          github,
          checksGithub: github,
          mutationGithub: github,
          targets: [],
          dryRun: false,
          cursorPath,
          core: { info: (line) => logs.push(line) },
        }),
        /Unfinished PR mutation.*"number":11.*"commentId":200/,
      );
      assert.deepEqual(first.writes, ["close-comment", "close"]);
      assert.deepEqual(second.writes, ["close-comment"]);
      assert.deepEqual(JSON.parse(await readFile(cursorPath, "utf8")), { lastNumber: 10 });
      assert.ok(
        logs.some((line) => line.includes('"closed":1') && line.includes('"unfinished":true')),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  for (const stage of [
    "first-read",
    "comment-readback",
    "close-readback",
    "later-read",
    "later-pre-mutation-read",
    "later-evaluation",
  ]) {
    it(`finalizes known effects after ${stage} failure`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "stale-pr-test-"));
      try {
        const first = harness(snapshot(10));
        const second = harness(snapshot(11));
        const failure = new Error(`injected ${stage}`);
        if (stage === "first-read") {
          first.options.github.rest.pulls.get = async () => {
            throw failure;
          };
        }
        if (stage === "comment-readback") {
          first.options.github.rest.issues.getComment = async () => {
            throw failure;
          };
        }
        if (stage === "close-readback") {
          first.options.github.rest.issues.get = async () => {
            throw failure;
          };
        }
        if (stage === "later-read") {
          second.options.github.rest.pulls.get = async () => {
            throw failure;
          };
        }
        if (stage === "later-pre-mutation-read") {
          const read = second.options.github.rest.pulls.get;
          let reads = 0;
          second.options.github.rest.pulls.get = async (...args) => {
            if (++reads === 2) {
              throw failure;
            }
            return read(...args);
          };
        }
        if (stage === "later-evaluation") {
          second.options.github.rest.pulls.get = async () => ({
            data: { ...structuredClone(second.state.pr), labels: [null] },
          });
        }
        const logs = [];
        const outputs = [];
        const cursorPath = join(dir, "cursor");
        await assert.rejects(
          runStaleLifecycle({
            ...batchHarness(first, second),
            cursorPath,
            core: { info: (line) => logs.push(line), setOutput: (...args) => outputs.push(args) },
          }),
          stage === "later-evaluation" ? TypeError : new RegExp(`injected ${stage}`),
        );
        const summary = JSON.parse(
          logs
            .find((line) => line.startsWith("Stale issue/PR scan "))
            .slice("Stale issue/PR scan ".length),
        );
        assert.equal(
          summary.closed,
          stage === "close-readback" || stage.startsWith("later") ? 1 : 0,
        );
        assert.equal(summary.unfinished, true);
        assert.equal(summary.failedTarget, stage.startsWith("later") ? 11 : 10);
        assert.equal(summary.next, stage.startsWith("later") ? 10 : null);
        assert.deepEqual(second.writes, []);
        assert.deepEqual(
          first.writes,
          stage === "first-read"
            ? []
            : stage === "comment-readback"
              ? ["close-comment"]
              : ["close-comment", "close"],
        );
        if (stage.startsWith("later")) {
          assert.deepEqual(JSON.parse(await readFile(cursorPath, "utf8")), { lastNumber: 10 });
          assert.deepEqual(outputs, [["checkpoint-written", "true"]]);
        } else {
          assert.deepEqual(outputs, []);
          await assert.rejects(readFile(cursorPath), { code: "ENOENT" });
        }
        if (["comment-readback", "close-readback"].includes(stage)) {
          assert.ok(summary.failures[0].includes('"commentId":200'));
        }
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  for (const alsoReadFailure of [false, true]) {
    it(`reports confirmed closes when checkpoint persistence fails${alsoReadFailure ? " after a read error" : ""}`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "stale-pr-test-"));
      try {
        const cursorPath = join(dir, "cursor");
        const first = harness(snapshot(10));
        const second = harness(snapshot(11));
        const close = first.options.github.rest.pulls.update;
        first.options.github.rest.pulls.update = async (params) => {
          const response = await close(params);
          await mkdir(cursorPath);
          return response;
        };
        const original = new Error("later target unavailable");
        if (alsoReadFailure) {
          second.options.github.rest.pulls.get = async () => {
            throw original;
          };
        }
        const logs = [];
        const outputs = [];
        const options = batchHarness(first, second);
        let caught;
        try {
          await runStaleLifecycle({
            ...options,
            detailLimit: alsoReadFailure ? 2 : 1,
            cursorPath,
            core: { info: (line) => logs.push(line), setOutput: (...args) => outputs.push(args) },
          });
        } catch (error) {
          caught = error;
        }
        assert.ok(caught);
        if (alsoReadFailure) {
          assert.ok(caught instanceof AggregateError);
          assert.equal(caught.cause, original);
          assert.equal(caught.errors[0], original);
          assert.equal(caught.errors[1].code, "EISDIR");
        } else {
          assert.equal(caught.code, "EISDIR");
        }
        const summary = JSON.parse(
          logs
            .find((line) => line.startsWith("Stale issue/PR scan "))
            .slice("Stale issue/PR scan ".length),
        );
        assert.equal(summary.closed, 1);
        assert.equal(summary.next, 10);
        assert.equal(summary.unfinished, true);
        assert.equal(summary.checkpointWritten, false);
        assert.equal(summary.failures.length, alsoReadFailure ? 2 : 1);
        assert.deepEqual(outputs, []);
        assert.deepEqual(first.writes, ["close-comment", "close"]);
        assert.deepEqual(second.writes, []);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("honors an explicit zero closure cap", async () => {
    const h = harness();
    await runStaleLifecycle({ ...h.options, dryRun: false, maxClosures: 0 });
    assert.deepEqual(h.writes, []);
  });

  it("persists only an evaluator-produced checkpoint after failure, never on cancellation", async () => {
    const yaml = await readFile(
      new URL("../../.github/workflows/stale.yml", import.meta.url),
      "utf8",
    );
    for (const marker of [
      "- uses: actions/cache/save@",
      "- name: Verify issue/PR scan checkpoint persistence",
    ]) {
      const condition = yaml
        .slice(yaml.indexOf(marker))
        .split("\n")
        .find((line) => line.includes("if:"));
      assert.match(condition, /!cancelled\(\)/);
      assert.match(condition, /steps\.evaluate\.outputs\.checkpoint-written == 'true'/);
      assert.match(condition, /inputs\.dry_run == false/);
      assert.match(condition, /inputs\.item_numbers == ''/);
    }
    const h = harness();
    const outputs = [];
    h.options.core.setOutput = (...output) => outputs.push(output);
    await runStaleLifecycle(h.options);
    await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.deepEqual(outputs, [], "dry and exact routes cannot publish a broad checkpoint");
    h.state.pr.state = "open";
    h.options.github.rest.pulls.get = async () => {
      throw new Error("reader unavailable");
    };
    await assert.rejects(
      runStaleLifecycle({ ...h.options, targets: [], dryRun: false }),
      /reader unavailable/,
    );
    assert.deepEqual(outputs, [], "setup/read failure cannot claim a newly written checkpoint");
  });

  it("paginates human comments and inline edits beyond the first page", async () => {
    const seed = snapshot();
    seed.comments.push(...Array.from({ length: 100 }, (_, id) => comment(id + 2, "bot work", OLD)));
    seed.comments.push(comment(102, "author response", RECENT, human));
    seed.reviewComments = Array.from({ length: 100 }, (_, id) =>
      comment(id + 200, "bot review", OLD),
    );
    seed.reviewComments.push(comment(301, "edited response", RECENT, human));
    const h = harness(seed);
    const result = await runStaleLifecycle({ ...h.options, dryRun: false });
    assert.equal(result.closed, 0);
    assert.deepEqual(h.writes, ["unlabel"]);
    assert.ok(h.pages.some((item) => item.endpoint === "comments" && item.page === 2));
    assert.ok(h.pages.some((item) => item.endpoint === "review-comments" && item.page === 2));
  });

  it("does not classify a User as automation from its login", () => {
    const seed = snapshot();
    seed.comments.push(
      comment(2, "response", RECENT, { id: 999, type: "User", login: "clawsweeper" }),
    );
    assert.equal(evaluateItem(seed, NOW).action, "unmark");
  });

  it("advances live checkpoints across its own closures and resets at the end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stale-pr-test-"));
    try {
      const cursorPath = join(dir, "cursor");
      const h = harness();
      const pulls = [10, 11, 12].map((number) => snapshot(number).pr);
      h.options.github.rest.pulls.list = async ({ page }) => ({
        data: page === 1 ? structuredClone(pulls.filter((pr) => pr.state === "open")) : [],
      });
      h.options.github.rest.pulls.get = async ({ pull_number }) => ({
        data: structuredClone(pulls.find((pr) => pr.number === pull_number)),
      });
      h.options.github.rest.pulls.update = async ({ pull_number }) => {
        pulls.find((pr) => pr.number === pull_number).state = "closed";
        return { data: structuredClone(pulls.find((pr) => pr.number === pull_number)) };
      };
      for (const number of [10, 11, 12]) {
        const result = await runStaleLifecycle({
          ...h.options,
          targets: [],
          dryRun: false,
          detailLimit: 1,
          cursorPath,
        });
        assert.equal(result.decisions[0].number, number);
        assert.equal(result.closed, 1);
      }
      assert.deepEqual(JSON.parse(await readFile(cursorPath, "utf8")), { lastNumber: null });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("resumes by identity after earlier closures and resets a completed cycle", async () => {
    const first = Array.from({ length: 205 }, (_, index) => ({ number: index + 1 }));
    const a = selectScanSlice(first, null, 100);
    assert.equal(a.next, 100);
    const changed = first.filter((item) => item.number > 100);
    changed.push({ number: 206 });
    const b = selectScanSlice(changed, a.next, 100);
    assert.equal(b.selected[0].number, 101);
    assert.equal(b.next, 200);
    const c = selectScanSlice(changed, b.next, 100);
    assert.deepEqual(
      c.selected.map((item) => item.number),
      [201, 202, 203, 204, 205, 206],
    );
    assert.equal(c.next, null);
    assert.equal(selectScanSlice([{ number: 3 }, ...changed], c.next, 100).selected[0].number, 3);
    const dir = await mkdtemp(join(tmpdir(), "stale-pr-test-"));
    try {
      const cursorPath = join(dir, "cursor");
      await writeFile(cursorPath, '{"lastNumber":123}\n');
      const h = harness();
      await runStaleLifecycle({ ...h.options, cursorPath });
      assert.equal(await readFile(cursorPath, "utf8"), '{"lastNumber":123}\n');
      await runStaleLifecycle({ ...h.options, dryRun: false, cursorPath });
      assert.equal(await readFile(cursorPath, "utf8"), '{"lastNumber":123}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
