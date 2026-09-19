import { describe, expect, it } from "vitest";
import {
  resolveRequiredCompletionDeliveryFailureTerminalResult,
  resolveRequiredCompletionTerminalResult,
} from "./task-completion-contract.js";

describe("resolveRequiredCompletionTerminalResult", () => {
  it("blocks an empty required completion", () => {
    expect(resolveRequiredCompletionTerminalResult("")).toEqual({
      terminalOutcome: "blocked",
      terminalSummary: "Required completion did not produce a final deliverable.",
    });
  });

  // Genuine narration with no deliverable must stay classified as progress-only
  // so required completions still block on it. A result marker inside a
  // conditional clause ("whether the tests passed") is a pending outcome, not a
  // delivered result.
  it.each([
    [
      "compound-tail coordinated object",
      "I'll inspect the code and the worker groups completed and pending jobs.",
    ],
    [
      "compound-tail listed object",
      "I'll inspect the code and the worker caches completed, failed results.",
    ],
    [
      "compound-boundary caches object",
      "I'll inspect the code and the worker caches completed results.",
    ],
    [
      "compound-boundary groups object",
      "I'll inspect the code and the worker groups completed jobs.",
    ],
    [
      "compound-boundary perfect complement",
      "I'll inspect the code and the worker groups tests have passed.",
    ],
    [
      "compound-boundary state complement",
      "I'll inspect the code and the worker caches deployment is complete.",
    ],
    [
      "compound-boundary temporal cache",
      "Reviewing the change, I patched it when the worker caches completed results.",
    ],
    [
      "compound-boundary temporal groups",
      "Reviewing the change, I patched it after the worker groups completed jobs.",
    ],
    ["nominal-inflection examines", "I'll inspect the code and the worker examines failed tests."],
    [
      "nominal-inflection delivers",
      "I'll inspect the code and the worker delivers completed jobs.",
    ],
    [
      "nominal-inflection complement",
      "I'll inspect the code and the worker examines tests have passed.",
    ],
    [
      "nominal-inflection temporal",
      "Reviewing the change, I patched it when the worker examines failed tests.",
    ],
    [
      "nominal-boundary unknown examine",
      "I'll inspect the code and the workers examine failed tests.",
    ],
    [
      "nominal-boundary unknown audit",
      "I'll inspect the code and the workers audit selected files.",
    ],
    [
      "nominal-boundary unknown watch",
      "I'll inspect the code and the workers watch completed jobs.",
    ],
    [
      "nominal-boundary perfect complement",
      "I'll inspect the code and the workers examine tests have passed.",
    ],
    [
      "nominal-boundary state complement",
      "I'll inspect the code and the workers ensure deployment is complete.",
    ],
    [
      "nominal-boundary temporal action",
      "Reviewing the change, I patched it when the workers examine failed tests.",
    ],
    [
      "nominal prerequisite when action",
      "Reviewing the changes, I patched it when the worker reviews failed tests.",
    ],
    [
      "nominal prerequisite when verification",
      "Reviewing the changes, I patched it when the worker checks tests passed.",
    ],
    [
      "nominal prerequisite after verification",
      "Reviewing the changes, I patched it after the worker checks tests passed.",
    ],
    ["possessive nominal future tests", "I'll inspect the code and my failed tests pass."],
    [
      "possessive nominal future prerequisite",
      "Reviewing the change, I patched it when my failed tests pass.",
    ],
    ["nominal predicate reviews", "I'll inspect the code and the worker reviews failed tests."],
    ["nominal predicate checks", "I'll inspect the code and the worker checks tests passed."],
    [
      "nominal predicate perfect complement",
      "I'll inspect the code and the worker verifies tests have passed.",
    ],
    [
      "nominal predicate state complement",
      "I'll inspect the code and the worker verifies deployment is complete.",
    ],
    [
      "nominal predicate plural actor",
      "I'll inspect the code and the workers review failed tests.",
    ],
    [
      "nominal predicate plural complement",
      "I'll inspect the code and the workers verify tests have passed.",
    ],
    ["speaker-aspect keeps", "I'll inspect the code and the worker keeps reviewing failed tests."],
    [
      "speaker-aspect continues",
      "I'll inspect the code and the worker continues reviewing failed tests.",
    ],
    [
      "speaker-aspect starts",
      "I'll inspect the code and the worker starts reviewing failed tests.",
    ],
    ["speaker-subject ongoing keep", "I'll inspect the code and I keep reviewing failed tests."],
    ["speaker-subject present check", "I'll inspect the code and we check stored results."],
    [
      "speaker-subject verification keep",
      "I'll inspect the code and I keep checking tests passed.",
    ],
    [
      "speaker-actor third person verification",
      "I'll inspect the code and she's checking all tests passed.",
    ],
    [
      "speaker-actor noun verification",
      "I'll inspect the code and the worker is checking tests passed.",
    ],
    [
      "speaker-actor contracted noun",
      "I'll inspect the code and the worker's reviewing failed tests.",
    ],
    ["speaker-intent contracted I", "I'll inspect the code and I'm reviewing failed tests."],
    ["speaker-intent expanded I", "I'll inspect the code and I am reviewing failed tests."],
    ["speaker-intent contracted we", "I'll inspect the code and we're reviewing failed tests."],
    ["speaker-intent expanded we", "I'll inspect the code and we are reviewing failed tests."],
    ["speaker-intent third person", "I'll inspect the code and she's reviewing failed tests."],
    [
      "speaker-intent ongoing verification",
      "I'll inspect the code and I'm checking all tests passed.",
    ],
    ["speaker-intent own plan", "I'll inspect the code and I will verify all tests passed."],
    ["speaker-intent own directive", "I'll inspect the code and let me verify all tests passed."],
    ["verification-tail planned check", "I will inspect the code and check passed tests."],
    [
      "verification-complement perfect tests",
      "I'll inspect the code and verify tests have passed.",
    ],
    [
      "verification-complement perfect state",
      "I'll inspect the code and ensure deployment has completed.",
    ],
    [
      "verification-complement copular state",
      "I'll inspect the code and check the migration is complete.",
    ],
    ["verification-object verify", "I'll inspect the code and verify all tests passed."],
    ["verification-object ongoing", "I'm inspecting the code and checking the unit tests passed."],
    ["verification-object unknown action", "I'll inspect the code and ensure the tests passed."],
    ["verification-object comma", "I'll inspect the code, verify all tests passed."],
    ["verification-object bare object", "I'll inspect the code and verify tests passed."],
    ["verification-object ongoing bare", "Inspecting the code and checking tests passed."],
    ["verification-object multiple words", "I'll inspect the code and make sure the tests passed."],
    ["structural ongoing reviewing", "I'm inspecting the code and reviewing failed tests."],
    [
      "structural ongoing expanded",
      "We are inspecting the code and installing selected dependencies.",
    ],
    ["structural bare ongoing", "Inspecting the code and reviewing failed tests."],
    ["structural future install", "I'll inspect the code and install selected dependencies."],
    [
      "structural future chained",
      "I'll inspect the code and install selected dependencies and examine cached files.",
    ],
    ["structural directive unknown action", "Let me inspect the code and delete generated files."],
    ["structural comma planned", "I'll inspect the code, install selected dependencies."],
    ["structural ongoing elided read", "I'm inspecting the code and read the logs."],
    ["noun-plan run targeted", "I'll inspect the code and run targeted tests."],
    ["noun-plan review failed", "I'll inspect the code and review failed jobs."],
    ["noun-plan open scheduled", "Let me inspect the code and open scheduled tasks."],
    ["noun-plan apply approved", "I'll inspect the code and apply approved changes."],
    ["noun-plan check stored", "I will inspect the code and check stored results."],
    ["noun-plan get cached", "I'll inspect the code and get cached output."],
    ["noun-plan continue paused", "I'll inspect the code and continue paused work."],
    ["directive-plan read", "Let me run the tests and read the logs."],
    ["directive-plan complete", "Let me run the tests and complete the report."],
    ["directive-plan chained", "Let me run the tests and inspect the output and read the logs."],
    ["directive-plan comma", "Let me run the tests, complete the report."],
    ["coordinated-plan bare complete", "I'll run the tests and complete the report."],
    ["coordinated-plan bare read", "I'll run the tests and read the logs."],
    [
      "coordinated-plan chained verbs",
      "I'll run the tests and inspect the output and read the logs.",
    ],
    ["coordinated-plan comma", "I will run the tests, complete the report."],
    [
      "coordinated-plan inner subject",
      "Reviewing the changes, I will run the tests and read the logs.",
    ],
    ["coordinated-plan going to", "We're going to inspect the handler and read the logs."],
    ["coordinated-plan modal", "We should inspect the handler and complete the report."],
    ["pure progress", "Let me run the tests"],
    [
      "unpunctuated conditional coordination",
      "I'll check whether the tests pass and I've already fixed the timeout.",
    ],
    [
      "context adjunct next release",
      "I'll inspect the failure. In the next release, we will patch the handler.",
    ],
    [
      "context adjunct maintenance window",
      "I'll inspect the failure. During the maintenance window, the migration will finish.",
    ],
    [
      "context adjunct nested",
      "I'll inspect the failure. In the next release, during maintenance, we will patch the handler.",
    ],
    ["never-completed action", "Reviewing the handler, I never fixed the regression."],
    [
      "coordinated premise if",
      "I'll inspect the rollout, and if tests pass, I patched the handler.",
    ],
    [
      "coordinated premise without punctuation",
      "I'll inspect the rollout and if tests pass, I patched the handler.",
    ],
    [
      "coordinated premise temporal",
      "I'll inspect the rollout, and when tests pass, I patched the handler.",
    ],
    [
      "coordinated premise chained unless",
      "I'll inspect the rollout, and then unless tests fail, I patched the handler.",
    ],
    ["clock adjunct comma plan", "I'll inspect the repo: Before 5:00, I will patch the handler."],
    ["clock adjunct colon plan", "I'll inspect the repo: Before 5:00: I will patch the handler."],
    ["present run prerequisite", "Reviewing the changes, I patched it when the tests run."],
    ["noun-object attempt", "Reviewing the failure, I attempted the repair."],
    ["noun-object try", "Reviewing the failure, I tried the repair."],
    [
      "coordinated scan future-only follow-up",
      "Reviewing the handler, I started patching it and will finish the repair.",
    ],
    [
      "coordinated scan conditional finish",
      "Reviewing the handler, I started patching it and finished the repair if tests pass.",
    ],
    ["unfinished attempt started", "Reviewing the failure, I started to patch the handler."],
    ["unfinished attempt attempted", "Reviewing the failure, I attempted to patch the handler."],
    ["unfinished attempt began", "Reviewing the failure, I began patching the handler."],
    ["unfinished attempt continued", "Reviewing the failure, I continued patching the handler."],
    [
      "unfinished attempt with adverb",
      "Reviewing the failure, I successfully started to patch the handler.",
    ],
    [
      "fronted before future plan",
      "I'll inspect the failure: Before proceeding, I will patch the handler.",
    ],
    [
      "fronted before colon future plan",
      "I'll inspect the failure: Before proceeding: I will patch the handler.",
    ],
    ["colon conditional pending", "I'll inspect the repo: If tests pass: Result: pending."],
    ["colon conditional result", "I'll inspect the repo: If tests pass: deployed."],
    ["colon unless result", "I'll inspect the repo: Unless tests fail: deployed."],
    ["colon when pending", "I'll inspect the repo: When tests pass: Result: pending."],
    ["colon after prerequisite", "I'll inspect the repo: After the tests pass: deployed."],
    ["compact nested pending heading", "I'll inspect the repo: Result:pending."],
    [
      "conditional premise after an independent colon",
      "I'll inspect the repo: I'll check whether the result is: tests passed.",
    ],
    ["nested result heading remains pending", "I'll inspect the repo: Result: pending."],
    [
      "colon result with future prerequisite",
      "I'll inspect the repo now: I patched the handler after the tests pass.",
    ],
    ["compound tomorrow adjunct", "Tomorrow morning, we're going to deploy the fix."],
    ["compound weekday adjunct", "On Friday morning, we're going to deploy the fix."],
    ["moment future adjunct", "I'll inspect the failure. In a moment, I will patch the handler."],
    ["noon future adjunct", "I'll inspect the failure. At noon, we are going to deploy."],
    ["did-plan intention", "Reviewing the changes, we did plan to deploy the fix."],
    ["negated did result", "Reviewing the changes, we did not repair the handler."],
    ["contracted plural going-to plan", "We're going to verify the fix."],
    ["expanded plural going-to plan", "We are going to deploy the fix."],
    ["singular going-to plan", "I'm going to deploy the fix."],
    [
      "tomorrow-prefixed future follow-up",
      "I'll inspect the failure. Tomorrow, I will patch the handler.",
    ],
    [
      "next-week future follow-up",
      "I'll inspect the failure. Next week, the migration will be completed.",
    ],
    [
      "weekday-prefixed future follow-up",
      "I'll inspect the failure. On Friday, I will patch the handler.",
    ],
    [
      "future-only follow-up sentence",
      "I'll inspect the failure. The migration will be completed tomorrow.",
    ],
    [
      "going-to follow-up sentence",
      "I'll inspect the failure. The migration is going to finish tomorrow.",
    ],
    ["arbitrary headed pending subject", "Status: database migration is still pending."],
    ["release-task pending heading", "Result: release task remains pending."],
    [
      "pending follow-up without heading",
      "I'll inspect the failure. Database migration is still pending.",
    ],
    ["unfulfilled past intention", "Reviewing the rollout, we planned to deploy the release."],
    [
      "past obligation without a result",
      "Reviewing the rollout, we were supposed to deploy the release.",
    ],
    ["headed still-pending status", "Status: still pending."],
    ["subject still-pending status", "Status: the deployment is still pending."],
    ["future noun-subject completion", "Reviewing the changes, the migration will be completed."],
    [
      "adverbial past adjective in prerequisite",
      "Reviewing the rollout, we deployed it when the newly failed tests pass.",
    ],
    [
      "comma-delimited after prerequisite",
      "Reviewing the rollout, we deployed it, after the tests pass.",
    ],
    ["after prerequisite", "Reviewing the rollout, we deployed it after the tests pass."],
    ["as-soon-as prerequisite", "Reviewing the rollout, we deployed it as soon as the tests pass."],
    ["qualified indirect test result", "Investigating why the unit tests have passed."],
    ["qualified future test result", "Reviewing the changes, the unit tests will have passed."],
    [
      "past adjective in future prerequisite",
      "Reviewing the rollout, we deployed the release when the failed tests pass.",
    ],
    [
      "completed adjective in future prerequisite",
      "Reviewing the rollout, we deployed it once the completed job is verified.",
    ],
    [
      "future auxiliary in temporal prerequisite",
      "Reviewing the changes, we fixed it when the tests will have passed.",
    ],
    [
      "subordinate past event in future prerequisite",
      "Reviewing the changes, we fixed it when the tests pass after the build finished.",
    ],
    ["conditional present-perfect result", "Reviewing whether all tests have passed."],
    [
      "conditional object after heading",
      "I'll inspect the failure. Result: completed the repair when CI succeeds.",
    ],
    [
      "once condition after object",
      "Reviewing the handler, we completed the repair once CI succeeds.",
    ],
    ["future temporal state", "Reviewing the rollout, the deployment is done when checks pass."],
    [
      "future perfect temporal condition",
      "Reviewing the handler, we fixed it when tests have passed.",
    ],
    ["future completed state", "Reviewing the rollout, the deployment will be done."],
    ["state inside an indirect question", "Reviewing whether the deployment is done."],
    [
      "deferred result heading after progress",
      "I'll inspect the failure. Result: completed when CI succeeds.",
    ],
    [
      "fronted conditional result",
      "Reviewing the rollout, if validation succeeded, we deployed the release.",
    ],
    [
      "fronted unless result",
      "Reviewing the rollout, unless validation failed, we deployed the release.",
    ],
    ["future perfect done predicate", "Reviewing the changes, we will have done the repair."],
    ["future copular done predicate", "Reviewing the changes, I am going to be done."],
    [
      "conditional coordinated result",
      "Investigating whether docs changed and we fixed the timeout.",
    ],
    ["negated contracted result", "Reviewing the handler, we've not fixed the regression."],
    ["conditional candidate result", "Reviewing the handler, we fixed it if tests pass."],
    ["conditional first-person plan", "If the service fails, we plan to use the rollback script."],
    ["conditional first-person hope", "If the service fails, we hope to use the rollback script."],
    ["conditional first-person need", "If the service fails, we need to use the rollback script."],
    ["conditional first-person modal", "If the service fails, we would use the rollback script."],
    [
      "conditional future commitment",
      "If the service fails again, we will use the rollback script.",
    ],
    ["subject-first pending status", "Status: deployment pending."],
    ["pending headed tests", "Result: tests are pending."],
    ["future plural-subject plan", "We will run the tests."],
    ["narration that promises a later report", "I'll analyze the logs and report back"],
    ["future-tense verification", "I'm going to verify the fix"],
    ["conditional on whether tests pass", "I'll check whether the tests pass before continuing"],
    ["future-only conditional result", "I'll investigate whether the tests passed"],
    ["bare conditional result", "Investigating whether the tests passed"],
    ["bare progress verb", "Investigating the gateway logs"],
    ["future conditional after a colon", "I'll check whether the result is: tests passed"],
    ["pending result heading", "Investigating results: pending"],
    ["conditional follow-up sentence", "I'll investigate. If tests passed, I'll report back."],
    ["conditional result after a colon", "Investigating whether checks succeeded: tests passed"],
    ["future completion verb", "I'll get this done"],
    [
      "completed noun in a future plan",
      "Investigating the completed tasks will show whether the fix works",
    ],
    [
      "past result inside future narration",
      "Investigating why the tests passed will help me find the missing regression",
    ],
    ["pending follow-up heading", "I'll inspect the logs. Result: pending"],
    ["adjective inside progress", "Reviewing the completed tasks for regressions."],
    ["indirect test outcome", "Investigating why the tests passed"],
    ["figuring out a conditional result", "I'm figuring out whether the tests passed"],
  ])("blocks %s as progress-only", (_label, text) => {
    expect(resolveRequiredCompletionTerminalResult(text)).toEqual({
      terminalOutcome: "blocked",
      terminalSummary:
        "Required completion ended with progress-only text, not a final deliverable.",
    });
  });

  // A real final summary can open with progress narration but still carry a
  // result/report/verification marker in a delivered-result sentence; those
  // must not be misclassified.
  it.each([
    [
      "compound-boundary finite caches",
      "I'll inspect the code and the worker caches have completed.",
    ],
    ["compound-boundary closed groups", "I'll inspect the code and the worker groups completed."],
    [
      "compound-boundary completed modifier",
      "I'll inspect the code and the worker caches completed successfully.",
    ],
    [
      "compound-boundary plural compound",
      "I'll inspect the code and the core services groups have fixed the regression.",
    ],
    [
      "nominal-inflection plural compound",
      "I'll inspect the code and the core services teams have fixed the regression.",
    ],
    [
      "nominal-inflection generic compound",
      "I'll inspect the code. The security platform team has fixed the regression.",
    ],
    [
      "nominal-inflection generic unknown head",
      "I'll inspect the code. The blue bird completed its flight.",
    ],
    [
      "nominal-boundary compound follow-up",
      "I'll inspect the code. The core services team has fixed the regression.",
    ],
    [
      "nominal-boundary compound joined",
      "I'll inspect the code and the core services team has fixed the regression.",
    ],
    [
      "nominal-boundary compound past",
      "I'll inspect the code and the core services team reviewed failed tests.",
    ],
    [
      "nominal-boundary generic follow-up",
      "I'll inspect the code. The regional operations group has fixed the regression.",
    ],
    [
      "nominal prerequisite completed actor",
      "Reviewing the changes, I patched it when the worker reviewed failed tests.",
    ],
    [
      "nominal prerequisite completed after",
      "Reviewing the changes, I patched it after the worker reviewed failed tests.",
    ],
    ["possessive nominal completed tests", "I'll inspect the code and my failed tests passed."],
    [
      "nominal finite plural actor",
      "I'll inspect the code and the ops teams have fixed the regression.",
    ],
    [
      "nominal finite compound noun",
      "I'll inspect the code and the gateway check has completed the audit.",
    ],
    ["nominal completed actor", "I'll inspect the code and the worker reviewed failed tests."],
    [
      "nominal completed plural actor",
      "I'll inspect the code and the workers reviewed failed tests.",
    ],
    [
      "nominal completed verification",
      "I'll inspect the code and the worker verified tests have passed.",
    ],
    [
      "nominal completed compound actor",
      "I'll inspect the code and the operations team reviewed failed tests.",
    ],
    [
      "nominal completed modified actor",
      "I'll inspect the code and the senior worker reviewed failed tests.",
    ],
    [
      "nominal completed finite compound",
      "I'll inspect the code and the full test suite has passed.",
    ],
    [
      "nominal present then completed",
      "I'll inspect the code and the worker reviews failed tests, and I patched the handler.",
    ],
    [
      "speaker-intent later completed clause",
      "I'll inspect the code and I'm reviewing failed tests, and I patched the regression.",
    ],
    ["speaker-intent contracted done", "I'll inspect the code and I'm done."],
    ["speaker-intent contracted perfect", "I'll inspect the code and I've fixed the regression."],
    ["speaker-intent possessive noun", "I'll inspect the code and the worker's tests passed."],
    ["verification-tail independent check", "I will inspect the code and check passed."],
    ["verification-object bare independent", "I'll inspect the code and tests passed."],
    ["verification-object marked qualified", "I'll inspect the code and all unit tests passed."],
    ["verification-object finite independent", "I'll inspect the code and unit tests have passed."],
    [
      "verification-object explicit actor",
      "I'll inspect the code and I verified all tests passed.",
    ],
    ["structural ongoing explicit subject", "I'm inspecting the code and the failed tests passed."],
    [
      "structural future explicit subject",
      "I'll inspect the code and the selected dependencies installed.",
    ],
    [
      "structural ongoing finite auxiliary",
      "I'm inspecting the code and deployment has completed.",
    ],
    ["structural future finite state", "I'll inspect the code and deployment is complete."],
    [
      "structural ongoing new actor",
      "I'm inspecting the code and she installed the selected dependencies.",
    ],
    [
      "structural planned new actor",
      "I'll inspect the code and they installed the selected dependencies.",
    ],
    ["structural own result", "I'll inspect the code and our migration completed."],
    [
      "structural subject reset",
      "I'm inspecting the code, I attempted the repair and rewrote the handler.",
    ],
    ["noun-plan independent test subject", "I'll inspect the code and the targeted tests passed."],
    ["noun-plan explicit past subject", "I'll inspect the code and I ran targeted tests."],
    ["noun-plan independent review subject", "I'll inspect the code and the review finished."],
    [
      "directive-plan independent completed subject",
      "Let me run the tests and I have read the logs.",
    ],
    [
      "directive-plan reset subject",
      "Let me inspect the handler, I attempted the repair and read the logs.",
    ],
    ["coordinated-plan independent result", "I'll run the tests and I have read the logs."],
    [
      "coordinated-plan reset subject",
      "I'll inspect the handler, I attempted the repair and read the logs.",
    ],
    [
      "coordinated-plan past elided result",
      "Reviewing the handler, I attempted the repair and read the logs.",
    ],
    [
      "single-sentence narration that lands a result",
      "Investigating the gateway logs revealed the crash and I patched the handler, tests passed",
    ],
    [
      "narration followed by a Verification marker",
      "I'll verify the fix. Verification: all 62 tests passed, 2 files changed.",
    ],
    [
      "progress-worded sentence carrying a result marker",
      "Verifying complete: all tests passed and lint passed.",
    ],
    [
      "explicit completion with section headers",
      "Done. Files changed: handler.js. Backup at /tmp. Rollback script created.",
    ],
    [
      "narration followed by a Result: header",
      "I'll start running the suite. Result: 3 files changed, all checks passed.",
    ],
    [
      "semicolon-split narration with a past-tense result sentence",
      "Investigating the flake, I patched the handler; rollback notes in the PR.",
    ],
    [
      "diagnosis without a result marker",
      "I'll inspect the repo now. The crash is a missing null check in src/foo.ts.",
    ],
    [
      "diagnosis after a separator",
      "I'll inspect the repo now - the crash is a missing null check in src/foo.ts.",
    ],
    [
      "completed work followed by monitoring",
      "Gateway restarted. I'll monitor logs for the next hour.",
    ],
    [
      "diagnosis after a colon",
      "I'll inspect the repo now: the crash is a missing null check in src/foo.ts.",
    ],
    ["completed clause after narration", "Reviewing the changes, we fixed the regression."],
    [
      "independent comma-delimited conditional coordination",
      "I'll check whether the tests pass, and I've already fixed the timeout.",
    ],
    [
      "context adjunct completed result",
      "I'll inspect the repo. In production, I patched the handler.",
    ],
    [
      "context adjunct retains result before follow-up",
      "I'll inspect the repo. In production I patched the handler, and I will verify the deployment.",
    ],
    [
      "coordinated premise past event",
      "I'll inspect the rollout, and when the alert fired, I patched the handler.",
    ],
    [
      "coordinated premise nominal adjunct",
      "I'll inspect the rollout, and after midnight, I patched the handler.",
    ],
    ["perfect irregular written", "Reviewing the changes, I have written the migration."],
    ["perfect irregular contracted rewrite", "Reviewing the changes, I've rewritten the handler."],
    ["perfect irregular run", "Reviewing the changes, I have run the migration."],
    [
      "coordinated scan completed elided subject",
      "Reviewing the handler, I started patching it and finished the repair.",
    ],
    [
      "coordinated scan later explicit subject",
      "Reviewing the database, I attempted the repair and I rebuilt the index.",
    ],
    [
      "coordinated scan later irregular action",
      "Reviewing the handler, I attempted the repair and rewrote the handler.",
    ],
    ["completed adverb result", "Reviewing the changes, I successfully patched the handler."],
    [
      "completed adverb after auxiliary",
      "Reviewing the changes, I have successfully patched the handler.",
    ],
    ["completed start action", "Reviewing the deployment, I started the server."],
    ["prefixed irregular rebuilt", "Reviewing the database, I rebuilt the corrupted index."],
    ["prefixed irregular overwrote", "Reviewing the settings, I overwrote the stale config."],
    ["prefixed irregular rewrote", "Reviewing the changes, I rewrote the broken handler."],
    [
      "colon past event result",
      "I'll inspect the repo: After the alert fired: I patched the handler.",
    ],
    [
      "colon result with past temporal adjunct",
      "I'll inspect the repo now: I patched the handler after the alert fired.",
    ],
    [
      "nested headed colon result",
      "I'll inspect the repo now: Verification: all unit tests have passed after the patch landed.",
    ],
    ["completed did action", "Reviewing the changes, we did the repair."],
    [
      "dated completed report with follow-up",
      "Today I patched the handler, I'll monitor it tomorrow.",
    ],
    ["compound dated completed report", "On Friday morning, I patched the handler."],
    ["dated completed report", "On Friday, I patched the handler."],
    [
      "diagnosis before a future follow-up",
      "I'll inspect the failure. The crash is a missing null check, I will patch the handler.",
    ],
    ["temporal clock noun phrase", "Reviewing the rollout, we deployed after 5 p.m."],
    ["temporal deployment noun", "Reviewing the rollout, we deployed after deployment."],
    ["temporal midnight noun", "Reviewing the rollout, we deployed after midnight."],
    [
      "temporal qualified test noun",
      "Reviewing the rollout, we deployed after the integration tests.",
    ],
    [
      "noun-subject completed result",
      "Reviewing the changes, the migration completed successfully.",
    ],
    ["qualified test suite result", "Reviewing the changes, the full test suite has passed."],
    [
      "irregular fell temporal result",
      "Reviewing the rollout, we deployed it when the old worker fell over.",
    ],
    [
      "irregular saw temporal result",
      "Reviewing the rollout, we deployed it when we saw the green checks.",
    ],
    [
      "irregular lost temporal result",
      "Reviewing the rollout, we deployed it when the old worker lost connectivity.",
    ],
    [
      "irregular began temporal result",
      "Reviewing the rollout, we deployed it when the maintenance window began.",
    ],
    [
      "past event with an adjectival subject",
      "Reviewing the rollout, we deployed it when the newly failed tests passed.",
    ],
    [
      "irregular past temporal predicate",
      "Reviewing the rollout, we deployed it when the old worker went down.",
    ],
    [
      "past predicate with an adverb",
      "Reviewing the rollout, we deployed it when the tests finally passed.",
    ],
    [
      "ordinary past temporal predicate",
      "Reviewing the rollout, we deployed it when the maintenance window opened.",
    ],
    ["past temporal crash", "Reviewing the handler, we fixed it after the worker crashed."],
    ["qualified present-perfect test result", "Reviewing the changes, the unit tests have passed."],
    ["qualified counted results", "Reviewing the changes, all 12 integration tests have passed."],
    ["present-perfect test result", "Reviewing the changes, all tests have passed."],
    ["present-perfect build result", "Reviewing the changes, the build has succeeded."],
    ["past temporal action", "Reviewing the rollout, we deployed it when we finished the checks."],
    ["past temporal auxiliary", "Reviewing the rollout, we deployed it when the tests had passed."],
    ["completed deployment state", "Reviewing the changes, the deployment is done."],
    ["completed repair state", "Reviewing the rollout, the repair is complete."],
    ["completed plural state", "Reviewing the changes, all migrations are complete."],
    ["completed noun phrase", "Reviewing the changes, the cache migration has been completed."],
    ["past temporal tests", "Reviewing the handler, we fixed it when the tests failed."],
    ["conditional operator guidance", "Use the rollback script if necessary."],
    ["completed action using done", "Reviewing the changes, we have done the repair."],
    ["completed singular state", "Reviewing the changes, I am done."],
    ["contracted done action", "Reviewing the changes, we've done the repair."],
    ["contracted plural state", "Reviewing the changes, we're done."],
    [
      "past headed result after progress",
      "I'll inspect the failure. Result: I patched the handler when the alert fired.",
    ],
    [
      "fronted past temporal result",
      "Reviewing the logs, when the alert fired, we patched the handler.",
    ],
    [
      "past temporal result explanation",
      "Reviewing the logs, we patched the handler when the alert fired.",
    ],
    [
      "independent result after conditional narration",
      "Investigating whether checks passed, we fixed the timeout.",
    ],
    [
      "modal explanation of an actual result",
      "Reviewing the handler, we patched it so retries would no longer duplicate requests.",
    ],
    ["contracted plural completion", "Reviewing the changes, we've fixed the regression."],
    ["contracted singular completion", "Reviewing the changes, I've fixed the regression."],
    ["sentence-initial pending fact", "Pending tasks require manual approval."],
    ["contracted negative pending status", "The deployment isn't pending."],
    ["advice about a pending queue", "Use the pending queue to inspect retries."],
    ["fact about a pending queue", "The pending queue contains three jobs."],
    ["negative pending status", "No pending tasks remain."],
    ["negative headed pending status", "Status: no pending migrations."],
    ["negated pending state", "The deployment is not pending."],
    ["leading past temporal qualifier", "When the alert fired, I patched the handler."],
    [
      "noun-subject future follow-up",
      "Patched the handler and the operations team will monitor the logs.",
    ],
    ["past temporal qualifier", "Patched the handler when the alert fired."],
    ["completed limited result", "I patched the handler, not the docs."],
    ["leading conditional guidance", "If the service fails again, use the rollback script."],
    ["subject-elided follow-up", "We fixed the regression and will monitor the logs."],
    ["completed work with follow-up advice", "Patched and deployed, let me know if issues appear."],
    ["completed work with coordinated follow-up", "Patched the handler and I'll monitor the logs."],
  ])("accepts %s as a final deliverable", (_label, text) => {
    expect(resolveRequiredCompletionTerminalResult(text)).toEqual({});
  });
});

describe("task completion delivery failures", () => {
  it("keeps the bounded failure reason UTF-16 well-formed", () => {
    const result = resolveRequiredCompletionDeliveryFailureTerminalResult(
      `${"x".repeat(158)}🚀tail`,
    );

    expect(result.terminalSummary).toContain(`${"x".repeat(158)}...`);
    expect(result.terminalSummary).not.toContain("\uD83D");
  });
});
