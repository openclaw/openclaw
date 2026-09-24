import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createMergeOutcomeFixtureHarness } from "./pr-merge-outcome.test-support.js";

const { fixture, outcomeRef, describePosix } = createMergeOutcomeFixtureHarness();

describePosix("native auto-merge recovery", () => {
  it("suspends unknown auto dispatch until reviewed replacement release and explicit immediate recovery", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    const first = f.run(true);
    expect(first.status, first.output).toBe(1);
    expect(f.state().mutations, first.output).toBe(1);
    const original = f.git(["rev-parse", outcomeRef]);
    const originalRecord = f.record();
    const captures = f.captures();
    f.recover();
    const result = f.suspend(original);
    expect(result.status, result.output).toBe(0);
    expect(f.record()).toMatchObject({
      phase: "intent",
      accepted: false,
      route: "auto",
      landed: null,
      suspension: { outcome: original, actor: "fixture-operator", state: "confirmed" },
    });
    expect(f.record()).not.toHaveProperty("cancellation");
    expect(f.state()).toMatchObject({ mutations: 1, cancellations: 0, posts: 0 });
    const retired = f.git(["rev-parse", outcomeRef]);
    for (const [name, contents] of captures) {
      expect(f.git(["rev-parse", retired + ":suspension-captures/" + name])).toBe(
        f.git(["hash-object", "--stdin"], contents),
      );
    }
    expect(JSON.parse(f.git(["show", original + ":outcome.json"]))).toEqual(originalRecord);
    // An on-disk successor must not skip the recorded ready transition.
    const invalid = {
      ...originalRecord,
      route: "immediate",
      recovery: {
        outcome: retired,
        attempt: originalRecord.attempt,
        actor: "fixture-operator",
        reason: "explicit-operator-recovery",
      },
    };
    const blob = f.git(["hash-object", "-w", "--stdin"], JSON.stringify(invalid));
    const tree = f.git(["mktree"], `100644 blob ${blob}\toutcome.json\n`);
    const forged = f.commit(tree, [f.head, f.base, retired], "Invalid fixture successor\n");
    f.git(["update-ref", outcomeRef, forged, retired]);
    const refused = f.run();
    expect(refused.status, refused.output).toBe(1);
    expect(refused.output).toContain("invalid or unretained operator recovery provenance");
    f.recover();
    f.git(["update-ref", outcomeRef, retired, forged]);
    expect(f.run().status).toBe(1); // Routine reconciliation never dispatches.
    f.recover();
    const replacement = f.replacePreparedHead();
    f.protectHead();
    f.save({
      ...f.state(),
      mode: "success",
      readyResponse: "lost",
      requiredCheckName: "openclaw/ci-gate",
      staleDraftSkip: true,
      pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
    });
    const released = f.run(false, f.repo, "squash", retired, replacement);
    expect(released.status, released.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "ready", head: replacement, accepted: false });
    expect(f.state()).toMatchObject({ mutations: 1, draftTransitions: 1, readyTransitions: 1 });
    const ready = f.git(["rev-parse", outcomeRef]);
    const readyState = f.state();
    f.save({ ...readyState, writerPermission: "read" });
    expect(f.run(false, f.repo, "squash", ready).status).toBe(1);
    expect(f.git(["rev-parse", outcomeRef])).toBe(ready);
    f.recover();
    f.save(readyState);
    const recovered = f.run(false, f.repo, "squash", ready);
    expect(recovered.status, recovered.output).toBe(0);
    expect(f.record()).toMatchObject({
      phase: "commented",
      head: replacement,
      route: "immediate",
      recovery: { outcome: ready },
    });
    expect(f.state()).toMatchObject({ mutations: 2, cancellations: 0, posts: 1 });
    f.git(["merge-base", "--is-ancestor", original, outcomeRef]);
    expect(f.suspend(original).status).toBe(1);
    expect(f.state().mutations).toBe(2);
  });
  it("keeps absent-request suspension fail-closed across identity, authority, state and capture faults", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(1);
    const original = f.git(["rev-parse", outcomeRef]);
    f.recover();
    const baseline = f.state();
    const capture = join(f.worktree, ".local", f.captures()[0]![0]);
    const bytes = readFileSync(capture);
    for (const fault of [
      "stale",
      "head",
      "repo",
      "base",
      "queued",
      "queue-policy",
      "auto",
      "writer",
      "revoked",
      "reread",
      "capture",
    ]) {
      const next = structuredClone(baseline);
      if (fault === "head") {
        next.pr.headRefOid = f.base;
      }
      if (fault === "repo") {
        next.repoAuthority.node_id = "other-repo";
      }
      if (fault === "base") {
        next.pr.baseRefName = "other";
      }
      if (fault === "queued") {
        next.pr.isInMergeQueue = true;
      }
      if (fault === "queue-policy") {
        next.pr.isMergeQueueEnabled = true;
      }
      if (fault === "auto") {
        next.pr.autoMergeRequest = { mergeMethod: "SQUASH" };
      }
      if (fault === "writer") {
        next.writerPermission = "read";
      }
      if (fault === "revoked") {
        next.revokePermissionAt = 2;
      }
      if (fault === "reread") {
        next.observations = [{}, { pr: { headRefOid: f.base } }];
      }
      if (fault === "capture") {
        rmSync(capture);
        symlinkSync(join(f.root, "missing-capture"), capture);
      }
      f.save(next);
      const refused = f.suspend(fault === "stale" ? f.base : original);
      expect(refused.status, fault + ": " + refused.output).toBe(1);
      expect(f.state()).toMatchObject({ mutations: 1, draftTransitions: 0, readyTransitions: 0 });
      expect(f.git(["rev-parse", outcomeRef])).toBe(original);
      f.recover();
      if (fault === "capture") {
        rmSync(capture);
        writeFileSync(capture, bytes);
      }
    }
  });

  it("never repeats uncertain draft or ready writes, even when their responses are lost", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      draftResponse: "rejected",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(1);
    f.recover();
    const first = f.suspend(f.git(["rev-parse", outcomeRef]));
    expect(first.status, first.output).toBe(1);
    expect(f.record().suspension.state).toBe("requested");
    f.recover();
    const requested = f.git(["rev-parse", outcomeRef]);
    expect(f.suspend(requested).status).toBe(1);
    expect(f.state().draftTransitions).toBe(1);
    f.recover();
    f.save({ ...f.state(), pr: { ...f.state().pr, isDraft: true } });
    expect(f.suspend(requested).status).toBe(0);
    const suspended = f.git(["rev-parse", outcomeRef]);
    const replacement = f.replacePreparedHead();
    f.protectHead();
    f.save({
      ...f.state(),
      readyResponse: "rejected",
      pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
    });
    const release = f.run(false, f.repo, "squash", suspended, replacement);
    expect(release.status, release.output).toBe(1);
    const ready = f.git(["rev-parse", outcomeRef]);
    expect(f.record().phase).toBe("ready");
    f.recover();
    expect(f.run(false, f.repo, "squash", ready).status).toBe(1);
    expect(f.state()).toMatchObject({ mutations: 1, draftTransitions: 1, readyTransitions: 1 });
    f.recover();
    f.save({ ...f.state(), mode: "success", pr: { ...f.state().pr, isDraft: false } });
    const result = f.run(false, f.repo, "squash", ready);
    expect(result.status, result.output).toBe(0);
    expect(f.state()).toMatchObject({ mutations: 2, draftTransitions: 1, readyTransitions: 1 });
  });

  it("retains the draft barrier until exact-head review, completed CI and current authority pass", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      draftResponse: "lost",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(1);
    f.recover();
    expect(f.suspend(f.git(["rev-parse", outcomeRef])).status).toBe(0);
    const suspended = f.git(["rev-parse", outcomeRef]);
    const replacement = f.replacePreparedHead();
    f.protectHead();
    const baseline = f.state();
    const gatesPath = join(f.worktree, ".local/gates.env");
    const gates = readFileSync(gatesPath, "utf8");
    for (const fault of [
      "ci",
      "pending",
      "failed",
      "review",
      "writer",
      "revoked",
      "released-externally",
      "pending-stamp",
      "artifact",
      "local-head",
      "no-net-change",
    ]) {
      const next = structuredClone(baseline);
      if (fault === "no-net-change") {
        f.advance("reviewed replacement\n", "stable\n");
      }
      if (fault === "ci") {
        next.ciExit = 15;
      }
      if (fault === "pending") {
        next.gates = "pending";
      }
      if (fault === "failed") {
        next.gates = "fail";
      }
      if (fault === "review") {
        next.issueComments[0]!.body = next.issueComments[0]!.body.replace(replacement, f.head);
      }
      if (fault === "writer") {
        next.writerPermission = "read";
      }
      if (fault === "revoked") {
        next.revokePermissionAt = next.permissionReads + 2;
      }
      if (fault === "released-externally") {
        next.pr.isDraft = false;
      }
      if (fault === "pending-stamp") {
        writeFileSync(gatesPath, gates.replace("GATES_MODE=full", "GATES_MODE=github_pending"));
      }
      if (fault === "artifact") {
        next.duringChecks = { artifact: "gates.env" };
      }
      if (fault === "local-head") {
        next.duringChecks = { preparedHead: f.head };
      }
      f.save(next);
      const result = f.run(false, f.repo, "squash", suspended, replacement);
      expect(result.status, fault + ": " + result.output).toBe(1);
      expect(f.state()).toMatchObject({ mutations: 1, readyTransitions: 0 });
      expect(f.git(["rev-parse", outcomeRef])).toBe(suspended);
      f.recover();
      writeFileSync(gatesPath, gates);
      if (fault === "local-head") {
        f.git(["-C", f.worktree, "checkout", "-B", "pr-123-prep", replacement]);
      }
    }
  });

  it.each(["draft", "ready"])(
    "reconciles a concurrent merge at the %s transition without a second merge",
    (stage) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "unapplied",
        draftResponse: stage === "draft" ? "merged" : "success",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(1);
      f.recover();
      const suspended = f.suspend(f.git(["rev-parse", outcomeRef]));
      expect(suspended.status, suspended.output).toBe(0);
      if (stage === "ready") {
        const original = f.git(["rev-parse", outcomeRef]);
        const replacement = f.replacePreparedHead();
        f.protectHead();
        f.save({
          ...f.state(),
          readyResponse: "merged",
          pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
        });
        const released = f.run(false, f.repo, "squash", original, replacement);
        expect(released.status, released.output).toBe(0);
      }
      expect(f.record().phase).toBe("merged");
      expect(f.state()).toMatchObject({ mutations: 1, posts: 0 });
    },
  );

  it("never sends ready without an admin-enforced fence, before an unreviewed final effect", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(1);
    f.recover();
    expect(f.suspend(f.git(["rev-parse", outcomeRef])).status).toBe(0);
    const suspended = f.git(["rev-parse", outcomeRef]);
    const replacement = f.replacePreparedHead();
    const unreviewed = f.commit(f.tree("UNREVIEWED\n"), [replacement], "Collaborator change\n");
    f.save({
      ...f.state(),
      readyResponse: "merged",
      collaboratorHead: unreviewed,
      pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
    });
    const main = f.git(["--git-dir=" + f.remote, "rev-parse", "main"]);
    const result = f.run(false, f.repo, "squash", suspended, replacement);
    expect(result.status, result.output).toBe(1);
    expect(result.output).toContain("head write fence unavailable");
    expect(f.state()).toMatchObject({
      readyTransitions: 0,
      acceptedHeadWrites: 0,
      pr: { state: "OPEN", isDraft: true, headRefOid: replacement },
    });
    expect(f.git(["--git-dir=" + f.remote, "rev-parse", "main"])).toBe(main);
    expect(f.git(["rev-parse", outcomeRef])).toBe(suspended);
  });

  it.each(["write", "admin"])(
    "the server fence rejects a %s collaborator head at the final ready/late-auto effect",
    (role) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "unapplied",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(1);
      f.recover();
      expect(f.suspend(f.git(["rev-parse", outcomeRef])).status).toBe(0);
      const suspended = f.git(["rev-parse", outcomeRef]);
      const replacement = f.replacePreparedHead();
      f.protectHead();
      const protection = f.state().headProtection;
      const unreviewed = f.commit(f.tree("UNREVIEWED\n"), [replacement], "Collaborator change\n");
      f.save({
        ...f.state(),
        collaboratorHead: unreviewed,
        collaboratorRole: role,
        readyResponse: "merged",
        pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
      });
      const result = f.run(false, f.repo, "squash", suspended, replacement);
      expect(result.status, result.output).toBe(0);
      expect(f.state()).toMatchObject({
        readyTransitions: 1,
        rejectedHeadWrites: 1,
        acceptedHeadWrites: 0,
        mutations: 1,
        pr: { state: "MERGED", headRefOid: replacement },
      });
      expect(f.record()).toMatchObject({
        phase: "merged",
        head: replacement,
        headFence: { ref: "refs/heads/topic" },
      });
      expect(f.git(["show", f.record().landed + ":owner.txt"])).toBe("reviewed replacement");
      expect(f.git(["--git-dir=" + f.remote, "rev-parse", "refs/heads/topic"])).toBe(replacement);
      expect(f.state().headProtection).toEqual(protection);
    },
  );

  it("refuses bypasses, stale branch identity, changed protection and revoked recovery fences", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(1);
    f.recover();
    expect(f.suspend(f.git(["rev-parse", outcomeRef])).status).toBe(0);
    const suspended = f.git(["rev-parse", outcomeRef]);
    const replacement = f.replacePreparedHead();
    f.protectHead();
    const baseline = f.state();
    for (const fault of [
      "unlocked",
      "admin-bypass",
      "force",
      "delete",
      "sync",
      "branch",
      "revoked",
      "forbidden",
      "errors",
      "repo-id",
      "repo-name",
      "repo-url",
      "viewer",
      "ref-name",
      "ref-prefix",
      "query-head",
      "wrong-rule",
      "missing-rule-id",
      "replaced-rule",
    ]) {
      const next = structuredClone(baseline);
      const protection = next.headProtection!;
      if (fault === "unlocked") {
        protection.lockBranch = false;
      }
      if (fault === "admin-bypass") {
        protection.isAdminEnforced = false;
      }
      if (fault === "force") {
        protection.allowsForcePushes = true;
      }
      if (fault === "delete") {
        protection.allowsDeletions = true;
      }
      if (fault === "sync") {
        protection.lockAllowsFetchAndMerge = true;
      }
      if (fault === "branch") {
        next.protectedHeadOverride = f.head;
      }
      if (fault === "revoked") {
        next.dropProtectionAt = 2;
      }
      if (
        [
          "forbidden",
          "errors",
          "repo-id",
          "repo-name",
          "repo-url",
          "viewer",
          "ref-name",
          "ref-prefix",
        ].includes(fault)
      ) {
        next.protectionReadFault = fault;
      }
      if (fault === "query-head") {
        next.protectionReadFault = "head";
      }
      if (fault === "wrong-rule") {
        protection.pattern = "other-branch";
      }
      if (fault === "missing-rule-id") {
        protection.id = "";
      }
      if (fault === "replaced-rule") {
        next.replaceProtectionAt = 2;
      }
      f.save(next);
      const result = f.run(false, f.repo, "squash", suspended, replacement);
      expect(result.status, fault + ": " + result.output).toBe(1);
      expect(f.state()).toMatchObject({ readyTransitions: 0, mutations: 1 });
      expect(f.git(["rev-parse", outcomeRef])).toBe(suspended);
      f.recover();
    }
    f.save(baseline);
    const released = f.run(false, f.repo, "squash", suspended, replacement);
    expect(released.status, released.output).toBe(0);
    const ready = f.git(["rev-parse", outcomeRef]);
    f.save({ ...f.state(), headProtection: null });
    const retry = f.run(false, f.repo, "squash", ready);
    expect(retry.status, retry.output).toBe(1);
    expect(f.state()).toMatchObject({ readyTransitions: 1, mutations: 1 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(ready);
  });

  it("requires a new draft barrier before changing a previously released fenced head", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "unapplied",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(1);
    f.recover();
    expect(f.suspend(f.git(["rev-parse", outcomeRef])).status).toBe(0);
    const suspended = f.git(["rev-parse", outcomeRef]);
    const firstHead = f.replacePreparedHead();
    f.protectHead();
    const first = f.run(false, f.repo, "squash", suspended, firstHead);
    expect(first.status, first.output).toBe(0);
    const ready = f.git(["rev-parse", outcomeRef]);
    const fence = f.record().headFence;
    // The operator drafts before relaxing the task-owned lock for repair,
    // preserving the rule ID. Native release must still observe that barrier.
    const drafting = f.state();
    drafting.headProtection!.lockBranch = false;
    f.save({ ...drafting, pr: { ...drafting.pr, isDraft: true } });
    const replacement = f.replacePreparedHead();
    f.protectHead();
    const next = f.state();
    next.issueComments[0]!.body = next.issueComments[0]!.body.replace(firstHead, replacement);
    f.save({ ...next, pr: { ...next.pr, isDraft: false } });
    const refused = f.run(false, f.repo, "squash", ready, replacement);
    expect(refused.status, refused.output).toBe(1);
    expect(f.state().readyTransitions).toBe(1);
    f.recover();
    f.save({ ...f.state(), pr: { ...f.state().pr, isDraft: true } });
    const second = f.run(false, f.repo, "squash", ready, replacement);
    expect(second.status, second.output).toBe(0);
    expect(f.record()).toMatchObject({
      phase: "ready",
      head: replacement,
      headFence: fence,
      recovery: { outcome: ready, replacementHead: replacement },
    });
    expect(f.state()).toMatchObject({ readyTransitions: 2, mutations: 1 });
    expect(f.run().status).toBe(1); // A readable successor is still reconciliation-only.
  });

  it.each([false, true])("does not suspend a known accepted intent (auto=%s)", (auto) => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending",
      pr: { ...f.state().pr, mergeStateStatus: auto ? "BLOCKED" : "CLEAN" },
    });
    expect(f.run(auto).status).toBe(0);
    const accepted = f.git(["rev-parse", outcomeRef]);
    const result = f.suspend(accepted);
    expect(result.status, result.output).toBe(1);
    expect(f.state()).toMatchObject({ mutations: 1, draftTransitions: 0 });
    expect(f.git(["rev-parse", outcomeRef])).toBe(accepted);
  });

  it.each(["success", "lost"])(
    "cancels accepted auto with %s response before recovering a reviewed replacement",
    (cancellation) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        cancellation,
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      const pending = f.run(true);
      expect(pending.status, pending.output).toBe(0);
      const accepted = f.git(["rev-parse", outcomeRef]);
      const captures = f.captures();
      const cancelled = f.cancel(accepted);
      expect(cancelled.status, cancelled.output).toBe(0);
      expect(f.state().pr.autoMergeRequest).toBeNull();
      expect(f.record()).toMatchObject({
        accepted: true,
        route: "auto",
        cancellation: { state: "confirmed", outcome: accepted, actor: "fixture-operator" },
      });
      const retired = f.git(["rev-parse", outcomeRef]);
      const retiredRecord = f.record();
      expect(retiredRecord).not.toHaveProperty("transport");
      const requested = f.git(["rev-list", "--parents", "-n", "1", retired]).split(" ").at(-1)!;
      const replacement = f.replacePreparedHead();
      f.save({
        ...f.state(),
        mode: "success",
        pooledMergeBlocked: true,
        quotaAt: "observe",
        quotaFailuresRemaining: 0,
        pr: { ...f.state().pr, mergeStateStatus: "CLEAN" },
      });
      const recovered = f.run(false, f.repo, "squash", retired, replacement);
      expect(recovered.status, recovered.output).toBe(0);
      expect(f.state()).toMatchObject({ mutations: 2, cancellations: 1, posts: 1 });
      expect(f.record()).toMatchObject({
        phase: "complete",
        head: replacement,
        recovery: { outcome: retired, replacementHead: replacement },
      });
      expect(f.record()).not.toHaveProperty("transport");
      expect(JSON.parse(f.git(["show", `${retired}:outcome.json`]))).toEqual(retiredRecord);
      expect(f.state().restMergePayload).toBeNull();
      expect(f.state().graphqlMergePayloads).toEqual([
        {
          pullRequestId: "fixture-pr",
          expectedHeadOid: replacement,
          mergeMethod: "SQUASH",
          commitBody: f.state().mergeBody,
        },
      ]);
      expect(f.state().mergeBody).toContain(f.state().previewBody);
      expect(f.git(["merge-base", "--is-ancestor", accepted, outcomeRef])).toBe("");
      for (const [name, contents] of captures) {
        expect(f.git(["show", `${requested}:${name}`])).toBe(contents.trim());
      }
    },
  );
  it("never repeats an uncertain auto cancellation and confirms its later observed retirement", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending",
      cancellation: "rejected",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(0);
    const first = f.cancel(f.git(["rev-parse", outcomeRef]));
    expect(first.status, first.output).toBe(1);
    expect(f.record().cancellation.state).toBe("requested");
    f.recover();
    const requested = f.git(["rev-parse", outcomeRef]);
    const retry = f.cancel(requested);
    expect(retry.status, retry.output).toBe(1);
    expect(f.state().cancellations).toBe(1);
    f.recover();
    f.save({ ...f.state(), pr: { ...f.state().pr, autoMergeRequest: null } });
    const confirmed = f.cancel(requested);
    expect(confirmed.status, confirmed.output).toBe(0);
    expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1 });
    expect(f.record().cancellation.state).toBe("confirmed");
  });
  it("reconciles a concurrent merge during auto cancellation without a second merge", () => {
    const f = fixture();
    f.save({
      ...f.state(),
      mode: "pending",
      cancellation: "merged",
      pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
    });
    expect(f.run(true).status).toBe(0);
    const result = f.cancel(f.git(["rev-parse", outcomeRef]));
    expect(result.status, result.output).toBe(0);
    expect(f.record()).toMatchObject({ phase: "merged", landed: f.state().pr.mergeCommit?.oid });
    expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1, posts: 0 });
  });
  it.each(["head", "queue", "reread"])(
    "preserves uncertain auto cancellation when %s changes during dispatch",
    (change) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(0);
      const changed = change === "queue" ? { isInMergeQueue: true } : { headRefOid: f.base };
      f.save({
        ...f.state(),
        observations: [{}, {}, ...(change === "reread" ? [{}] : []), { pr: changed }],
      });
      const result = f.cancel(f.git(["rev-parse", outcomeRef]));
      expect(result.status, result.output).toBe(1);
      expect(f.state()).toMatchObject({ cancellations: 1, mutations: 1 });
      expect(f.record().cancellation.state).toBe("requested");
    },
  );
  it.each(["head", "queue", "method", "absent"])(
    "refuses auto cancellation when %s no longer matches the retained request",
    (change) => {
      const f = fixture();
      f.save({
        ...f.state(),
        mode: "pending",
        pr: { ...f.state().pr, mergeStateStatus: "BLOCKED" },
      });
      expect(f.run(true).status).toBe(0);
      const accepted = f.git(["rev-parse", outcomeRef]);
      const next = f.state();
      if (change === "head") {
        next.pr.headRefOid = f.base;
      }
      if (change === "queue") {
        next.pr.isMergeQueueEnabled = true;
      }
      if (change === "method") {
        next.pr.autoMergeRequest = { mergeMethod: "MERGE" };
      }
      if (change === "absent") {
        next.pr.autoMergeRequest = null;
      }
      f.save(next);
      const result = f.cancel(accepted);
      expect(result.status, result.output).toBe(1);
      expect(f.state()).toMatchObject({ cancellations: 0, mutations: 1 });
      expect(f.git(["rev-parse", outcomeRef])).toBe(accepted);
    },
  );
});
