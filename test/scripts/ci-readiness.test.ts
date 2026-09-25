import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  inspectReadiness,
  readinessLabel,
  requestReadiness,
  validatePolicy,
} from "../../scripts/ci-readiness.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { evaluateWorkflowExpression } from "./ci-workflow.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const repository = "openclaw/openclaw";
const policy = { version: 1, mode: "canary", pullRequests: [42] };
const head = "a".repeat(40);
const base = "b".repeat(40);
const testedSha = "c".repeat(40);
const permission = { permission: "write", user: { id: 7 } };
const workflow = parse(readFileSync(".github/workflows/ci.yml", "utf8"));

function fixture() {
  const pr = {
    number: 42,
    state: "open",
    draft: false,
    merge_commit_sha: testedSha,
    head: { sha: head, ref: "feature", repo: { full_name: repository } },
    base: { sha: base, ref: "main", repo: { full_name: repository } },
    labels: [] as { name: string }[],
  };
  const label = readinessLabel(pr, policy);
  pr.labels.push({ name: label });
  const event = {
    action: "labeled",
    label: { name: label },
    sender: { login: "maintainer", id: 7 },
    pull_request: structuredClone(pr),
  };
  const labeled = {
    id: 101,
    event: "labeled",
    actor: { login: "maintainer", id: 7 },
    label: { name: label },
  };
  const ledger = [labeled];
  const writes: unknown[] = [];
  const api = vi.fn(
    async (path: string, options?: { method?: string; body?: unknown }): Promise<unknown> => {
      if (options?.method === "POST") {
        writes.push({ path, ...options });
        if (path.endsWith("/issues/42/labels") && !pr.labels.some((item) => item.name === label)) {
          pr.labels.push({ name: label });
          ledger.push({ ...labeled, id: 102 });
        }
        return {};
      }
      if (path.endsWith("/pulls/42")) {
        return structuredClone(pr);
      }
      if (path.includes("/events?")) {
        return structuredClone(ledger);
      }
      if (path.endsWith("/permission")) {
        return permission;
      }
      if (path === "user") {
        return { login: "maintainer", id: 7 };
      }
      if (path.includes("/contents/")) {
        return { content: Buffer.from(JSON.stringify(policy)).toString("base64") };
      }
      if (path.includes("/labels/")) {
        return { name: label };
      }
      throw new Error(`Unexpected API: ${path}`);
    },
  );
  return { pr, event, ledger, labeled, api, label, writes };
}

function inspect(f: ReturnType<typeof fixture>, overrides = {}) {
  return inspectReadiness({
    api: f.api,
    repository,
    event: f.event,
    policy,
    testedSha,
    ...overrides,
  });
}
function request(f: ReturnType<typeof fixture>) {
  return requestReadiness({ api: f.api, repository, number: 42, head, base });
}

describe("candidate readiness authority", () => {
  it.each(["opened", "synchronize", "reopened", "ready_for_review", "unlabeled"])(
    "defers %s even with a retained readiness label",
    async (action) => {
      const f = fixture();
      f.event.action = action;
      expect(await inspect(f)).toMatchObject({ broad_ci: "false", enforced: "true" });
      expect(f.api).not.toHaveBeenCalled();
    },
  );
  it("admits the exact candidate without waiting for review, then revalidates it for the gate", async () => {
    const f = fixture();
    expect(await inspect(f)).toMatchObject({ broad_ci: "true", request_id: "101" });
    expect(await inspect(f, { requestId: "101" })).toMatchObject({ broad_ci: "true" });
    expect(f.writes).toEqual([]);
  });
  it.each(["off", "canary"])("preserves ordinary CI outside %s rollout", async (mode) => {
    const f = fixture();
    f.event.action = "synchronize";
    expect(await inspect(f, { policy: { version: 1, mode, pullRequests: [] } })).toMatchObject({
      broad_ci: "true",
      enforced: "false",
    });
  });
  it("supports all-PR rollout including a maintainer-requested fork without changing source identity", async () => {
    const f = fixture();
    const all = { version: 1, mode: "all", pullRequests: [] };
    f.pr.head.repo.full_name = "contributor/openclaw";
    f.label = readinessLabel(f.pr, all);
    f.pr.labels = [{ name: f.label }];
    f.event.pull_request = structuredClone(f.pr);
    f.event.label.name = f.label;
    f.labeled.label.name = f.label;
    expect(await inspect(f, { policy: all })).toMatchObject({ broad_ci: "true" });
    expect(f.event.pull_request.head.repo.full_name).toBe("contributor/openclaw");
  });
  it.each(["draft", "closed"])("rejects invalid %s admission before API work", async (state) => {
    const f = fixture();
    if (state === "draft") {
      f.event.pull_request.draft = true;
    } else {
      f.event.pull_request.state = "closed";
    }
    await expect(inspect(f)).rejects.toThrow("open, non-draft");
  });
  it.each(["head", "base", "repository", "merge", "removed-label", "draft", "closed"])(
    "rejects live %s supersession",
    async (field) => {
      const f = fixture();
      if (field === "head" || field === "base") {
        f.pr[field].sha = "d".repeat(40);
      }
      if (field === "repository") {
        f.pr.head.repo.full_name = "someone/else";
      }
      if (field === "merge") {
        f.pr.merge_commit_sha = "d".repeat(40);
      }
      if (field === "removed-label") {
        f.pr.labels = [];
      }
      if (field === "draft") {
        f.pr.draft = true;
      }
      if (field === "closed") {
        f.pr.state = "closed";
      }
      await expect(inspect(f)).rejects.toThrow();
    },
  );
  it.each([
    "closed",
    "reopened",
    "convert_to_draft",
    "ready_for_review",
    "unlabeled",
    "base_ref_changed",
    "head_ref_force_pushed",
  ])("does not resurrect an admission after %s, even on the same head", async (event) => {
    const f = fixture();
    f.ledger.push({ ...f.labeled, id: 102, event });
    await expect(inspect(f, { requestId: "101" })).rejects.toThrow("revoked");
  });
  it("rejects a new label event when accepting an older request's result", async () => {
    const f = fixture();
    f.ledger.push({ ...f.labeled, id: 102 });
    await expect(inspect(f, { requestId: "101" })).rejects.toThrow("identity changed");
  });
  it("does not trust author association or the historical event actor's former permission", async () => {
    const f = fixture();
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path, options) =>
      path.endsWith("/permission") ? { permission: "read" } : api(path, options),
    );
    await expect(inspect(f)).rejects.toThrow("write permission");
  });
  it("binds requester authority to the immutable GitHub account, not a recycled login", async () => {
    const f = fixture();
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (route, options) =>
      route.endsWith("/permission")
        ? { permission: "write", user: { id: 8 } }
        : api(route, options),
    );
    await expect(inspect(f)).rejects.toThrow("identity changed");
    f.api.mockImplementation(api);
    f.event.sender.id = 8;
    await expect(inspect(f)).rejects.toThrow("identity changed");
  });
  it("checks a rerun actor independently of the original requester", async () => {
    const f = fixture();
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path, options) =>
      path.includes("/reader/permission") ? { permission: "read" } : api(path, options),
    );
    await expect(inspect(f, { triggeringActor: "reader" })).rejects.toThrow("write permission");
  });
  it("rejects mutations during authority reads and API failures", async () => {
    const f = fixture();
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path, options) => {
      if (path.endsWith("/permission")) {
        f.pr.head.sha = "d".repeat(40);
      }
      return api(path, options);
    });
    await expect(inspect(f)).rejects.toThrow("changed during admission");
    f.api.mockRejectedValue(new Error("unavailable"));
    await expect(inspect(f)).rejects.toThrow("unavailable");
  });
  it("accepts a stable forward base advance only at result acceptance, not a rewrite", async () => {
    const f = fixture();
    const api = f.api.getMockImplementation()!;
    f.pr.base.sha = "d".repeat(40);
    f.pr.merge_commit_sha = "e".repeat(40);
    f.api.mockImplementation(async (path, options) =>
      path.includes("/compare/")
        ? { status: "ahead", merge_base_commit: { sha: base } }
        : api(path, options),
    );
    expect(await inspect(f, { requestId: "101" })).toMatchObject({ broad_ci: "true" });
    await expect(inspect(f)).rejects.toThrow("superseded");
    f.api.mockImplementation(async (path, options) =>
      path.includes("/compare/")
        ? { status: "diverged", merge_base_commit: { sha: "f".repeat(40) } }
        : api(path, options),
    );
    await expect(inspect(f, { requestId: "101" })).rejects.toThrow("rewritten");
  });
  it("fails closed on an incomplete bounded event ledger", async () => {
    const f = fixture();
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (route, options) =>
      route.includes("/events?")
        ? Array.from({ length: 100 }, (_, i) => ({ ...f.labeled, id: 101 + i }))
        : api(route, options),
    );
    await expect(inspect(f)).rejects.toThrow("exceeds the readiness bound");
    expect(f.api.mock.calls.filter(([route]) => route.includes("/events?"))).toHaveLength(10);
  });
  it("binds labels to code, base, repository, branch, and policy", () => {
    const f = fixture();
    expect(f.label.length).toBeLessThanOrEqual(50);
    for (const key of ["head", "base"] as const) {
      const pr = structuredClone(f.pr);
      pr[key].sha = "d".repeat(40);
      expect(readinessLabel(pr, policy)).not.toBe(f.label);
    }
    expect(readinessLabel(f.pr, { ...policy, mode: "all" })).not.toBe(f.label);
    expect(() => validatePolicy({ ...policy, mode: "unknown" })).toThrow();
    expect(() =>
      validatePolicy({ ...policy, pullRequests: Array.from({ length: 11 }, (_, i) => i + 1) }),
    ).toThrow();
  });
});

describe("agent request entrypoint", () => {
  it.skipIf(process.platform === "win32")(
    "executes the workflow inspect entrypoint with the selected CLI",
    () => {
      const f = fixture();
      const directory = tempDirs.make("ci-readiness-cli-");
      const cli = join(directory, "gh-fixture");
      const eventPath = join(directory, "event.json");
      const policyPath = join(directory, "policy.json");
      const output = join(directory, "output");
      const summary = join(directory, "summary");
      writeFileSync(eventPath, JSON.stringify(f.event));
      writeFileSync(policyPath, JSON.stringify(policy));
      writeFileSync(
        cli,
        `#!${process.execPath}
const route = process.argv[5];
const data = route.includes('/events?') ? ${JSON.stringify(f.ledger)} : route.endsWith('/permission') ? {permission:'write',user:{id:7}} : ${JSON.stringify(f.pr)};
console.log(JSON.stringify(data));
`,
      );
      chmodSync(cli, 0o700);
      const result = spawnSync(
        process.execPath,
        ["scripts/ci-readiness.mjs", "inspect", "--policy", policyPath],
        {
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            OPENCLAW_GH_BIN: cli,
            GITHUB_REPOSITORY: repository,
            GITHUB_EVENT_PATH: eventPath,
            GITHUB_SHA: testedSha,
            GITHUB_OUTPUT: output,
            GITHUB_STEP_SUMMARY: summary,
            GITHUB_TRIGGERING_ACTOR: "maintainer",
          },
        },
      );
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(readFileSync(output, "utf8")).toContain("request_id=101");
      expect(readFileSync(summary, "utf8")).toContain(testedSha);
    },
  );
  it.each([404, 503])("handles base-policy API status %s without requesting CI", async (status) => {
    const f = fixture();
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (route, options) => {
      if (route.includes("/contents/")) {
        throw Object.assign(new Error("policy unavailable"), { status });
      }
      return api(route, options);
    });
    if (status === 404) {
      expect(await request(f)).toMatchObject({ status: "disabled" });
    } else {
      await expect(request(f)).rejects.toThrow("policy unavailable");
    }
    expect(f.writes).toEqual([]);
  });
  it("attaches duplicate requests without mutating GitHub", async () => {
    const f = fixture();
    expect(await request(f)).toMatchObject({ status: "attach", requestId: 101 });
    expect(f.writes).toEqual([]);
  });
  it("adds only the immutable label, preserving unrelated labels", async () => {
    const f = fixture();
    f.pr.labels = [{ name: "bug" }];
    expect(await request(f)).toMatchObject({ status: "requested", label: f.label });
    expect(f.writes).toEqual([
      { path: `repos/${repository}/issues/42/labels`, method: "POST", body: { labels: [f.label] } },
    ]);
    expect(f.pr.labels).toContainEqual({ name: "bug" });
  });
  it("creates the deterministic repository label only when absent", async () => {
    const f = fixture();
    f.pr.labels = [];
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (route, options) => {
      if (route.includes("/labels/")) {
        throw Object.assign(new Error("missing"), { status: 404 });
      }
      return api(route, options);
    });
    expect(await request(f)).toMatchObject({ status: "requested", label: f.label });
    expect(f.writes).toHaveLength(2);
    expect(f.writes[0]).toMatchObject({
      path: `repos/${repository}/labels`,
      method: "POST",
      body: { name: f.label },
    });
  });
  it("does not create labels on an API permission or availability error", async () => {
    const f = fixture();
    f.pr.labels = [];
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (route, options) => {
      if (route.includes("/labels/")) {
        throw Object.assign(new Error("forbidden"), { status: 403 });
      }
      return api(route, options);
    });
    await expect(request(f)).rejects.toThrow("forbidden");
    expect(f.writes).toEqual([]);
  });
  it("attaches after an ambiguous acknowledgement instead of submitting again", async () => {
    const f = fixture();
    f.pr.labels = [];
    const api = f.api.getMockImplementation()!;
    f.api.mockImplementation(async (path, options) => {
      const result = await api(path, options);
      if (options?.method === "POST") {
        throw new Error("connection lost");
      }
      return result;
    });
    expect(await request(f)).toMatchObject({ status: "attach" });
    expect(f.writes).toHaveLength(1);
  });
  it("reconciles concurrent callers through the existing label set", async () => {
    const f = fixture();
    f.pr.labels = [];
    const results = await Promise.all([request(f), request(f)]);
    expect(results.map((r) => r.status)).toContain("requested");
    // The GitHub add-label operation is a set insertion: concurrent identical
    // POSTs cannot add a second label; live event-delivery qualification is separate.
    expect(f.writes.every((w) => JSON.stringify(w).includes(f.label))).toBe(true);
    expect(f.pr.labels.filter((item) => item.name === f.label)).toHaveLength(1);
    expect(f.ledger.filter((item) => item.id === 102)).toHaveLength(1);
  });
  it("rejects a stale requested head before any writes", async () => {
    const f = fixture();
    f.pr.head.sha = "d".repeat(40);
    await expect(request(f)).rejects.toThrow("no longer current");
    expect(f.writes).toEqual([]);
  });
});

function evaluate(
  expression: string,
  eventName: "pull_request" | "push" | "workflow_dispatch",
  action = "synchronize",
  label = "",
  broad = "false",
  draft = false,
  merged = false,
  baseEdited = false,
) {
  return evaluateWorkflowExpression(
    expression.startsWith("${{") ? expression : `\${{ ${expression} }}`,
    {
      eventName,
      repository,
      runAttempt: 1,
      runId: 101,
      runNumber: 2,
      workflow: "CI",
      ref: "refs/heads/main",
      sha: testedSha,
      readinessBroadCi: broad === "true",
      githubEvent: {
        action,
        changes: { base: baseEdited ? { ref: { from: "other-base" } } : undefined },
        label: { name: label },
        pull_request: { state: action === "closed" ? "closed" : "open", draft, merged, number: 42 },
      },
    },
  );
}

describe("real CI workflow admission and required status", () => {
  it("keeps eligible PR events and leaves the planner, trust classifier, and dispatch separate", () => {
    expect(workflow.on.pull_request.types).toEqual(
      expect.arrayContaining([
        "synchronize",
        "labeled",
        "unlabeled",
        "closed",
        "converted_to_draft",
        "edited",
      ]),
    );
    expect(workflow.on.pull_request_target).toBeUndefined();
    const steps = workflow.jobs.preflight.steps;
    expect(steps.find((s: { name: string }) => s.name === "Build CI manifest").run).toContain(
      'eventName === "pull_request"',
    );
    expect(
      steps.find((s: { name: string }) => s.name === "Classify candidate cache trust").run,
    ).toContain("trust=pull-request\n  cache_mode=restore");
    for (const job of [workflow.jobs.readiness, workflow.jobs["ci-gate"]]) {
      const checkout = job.steps.find((s: { uses?: string }) =>
        s.uses?.startsWith("actions/checkout@"),
      );
      expect(checkout.with.ref).toBe("${{ github.event.pull_request.base.sha }}");
      expect(checkout.with["persist-credentials"]).toBe(false);
      expect(Object.values(job.permissions)).not.toContain("write");
    }
  });
  it("admits the unchanged PR planner only after readiness, preserving main and dispatch policy", () => {
    expect(evaluate(workflow.jobs.preflight.if, "pull_request")).toBe(false);
    expect(
      evaluate(workflow.jobs.preflight.if, "pull_request", "labeled", fixture().label, "true"),
    ).toBe(true);
    expect(evaluate(workflow.jobs.preflight.if, "push")).toBe(false);
    expect(evaluate(workflow.jobs.preflight.if, "workflow_dispatch")).toBe(true);
    expect(
      evaluate(workflow.jobs["security-fast"].if, "pull_request", "synchronize", "", "false", true),
    ).toBe(false);
  });
  it("metadata events cannot cancel CI or publish skipped required success", () => {
    expect(evaluate(workflow.jobs["ci-gate"].name, "pull_request", "labeled", "bug")).not.toBe(
      "openclaw/ci-gate",
    );
    expect(evaluate(workflow.concurrency.group, "pull_request", "labeled", "bug")).not.toBe(
      evaluate(workflow.concurrency.group, "pull_request"),
    );
    expect(
      evaluate(workflow.concurrency.group, "pull_request", "converted_to_draft", "", "false", true),
    ).toBe(evaluate(workflow.concurrency.group, "pull_request", "labeled", fixture().label));
    expect(
      evaluate(workflow.jobs["ci-gate"].name, "pull_request", "labeled", fixture().label),
    ).toBe("openclaw/ci-gate");
  });
  it("invalidates base-retargeted proof without letting title/body edits replace required CI", () => {
    const edited = (expression: string, baseEdited = false) =>
      evaluate(expression, "pull_request", "edited", "", "false", false, false, baseEdited);
    expect(edited(workflow.jobs.readiness.if, true)).toBe(true);
    expect(edited(workflow.jobs["security-fast"].if, true)).toBe(true);
    expect(edited(workflow.jobs["ci-gate"].if, true)).toBe(true);
    expect(edited(workflow.jobs["ci-gate"].name, true)).toBe("openclaw/ci-gate");
    expect(edited(workflow.jobs.readiness.if)).toBe(false);
    expect(edited(workflow.jobs["security-fast"].if)).toBe(false);
    expect(edited(workflow.jobs["ci-gate"].if)).toBe(false);
    expect(edited(workflow.jobs["ci-gate"].name)).not.toBe("openclaw/ci-gate");
    expect(edited(workflow.concurrency.group)).not.toBe(edited(workflow.concurrency.group, true));
  });
  it("keeps merged-close notifications off main's required CI context", () => {
    const merged = (expression: string) =>
      evaluate(expression, "pull_request", "closed", "", "false", false, true);
    expect(merged(workflow.jobs.readiness.if)).toBe(false);
    expect(merged(workflow.jobs.preflight.if)).toBe(false);
    expect(merged(workflow.jobs["security-fast"].if)).toBe(false);
    expect(merged(workflow.jobs["ci-gate"].if)).toBe(false);
    expect(merged(workflow.jobs["ci-gate"].name)).not.toBe("openclaw/ci-gate");
    expect(merged(workflow.concurrency.group)).not.toBe(
      evaluate(workflow.concurrency.group, "pull_request"),
    );
    expect(evaluate(workflow.jobs["ci-gate"].name, "pull_request", "closed")).toBe(
      "openclaw/ci-gate",
    );
    expect(evaluate(workflow.jobs["ci-gate"].if, "pull_request", "closed")).toBe(true);
  });
  it.skipIf(process.platform === "win32")(
    "rejects an enforced gate without its admitted request identity",
    () => {
      const step = workflow.jobs["ci-gate"].steps.find(
        (item: { name: string }) => item.name === "Verify selected CI lanes",
      );
      const result = spawnSync("bash", ["-c", step.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          READINESS_RESULT: "success",
          BROAD_CI: "true",
          READINESS_ENFORCED: "true",
          READINESS_REQUEST_ID: "",
          PREFLIGHT_RESULT: "success",
          RELEASE_PRIORITY_RUN: "",
          JOB_RESULTS: "build=success|true",
        },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain("CI readiness proof missing");
    },
  );
  it.skipIf(process.platform === "win32").each([
    ["false", "success", "build=skipped|false", 1],
    [
      "true",
      "success",
      "preflight=success|true\nsecurity-fast=success|true\nbuild=skipped|false",
      1,
    ],
    ["true", "success", "build=skipped|true", 1],
    ["true", "success", "build=failure|true", 1],
    ["true", "success", "build=cancelled|true", 1],
    ["true", "failure", "build=success|true", 1],
    ["true", "success", "build=success|true\nother=skipped|false", 0],
  ] as const)(
    "real aggregate: broad=%s readiness=%s results=%s",
    (broad, readiness, results, status) => {
      const step = workflow.jobs["ci-gate"].steps.find(
        (s: { name: string }) => s.name === "Verify selected CI lanes",
      );
      const result = spawnSync("bash", ["-c", step.run], {
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_EVENT_NAME: "pull_request",
          READINESS_RESULT: readiness,
          BROAD_CI: broad,
          PREFLIGHT_RESULT: "success",
          RELEASE_PRIORITY_RUN: "",
          JOB_RESULTS: results,
        },
      });
      expect(result.status, result.stdout + result.stderr).toBe(status);
    },
  );
});
