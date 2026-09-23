import { describe, expect, it, vi } from "vitest";
import {
  explicitCommandRoute,
  replayRoute,
  runCase,
  runExperiment,
} from "../../scripts/scoped-decision/decision.ts";
import { fixtures } from "../../scripts/scoped-decision/fixtures.ts";
import type {
  ClassifierObservation,
  ClassifierRoute,
  HostState,
} from "../../scripts/scoped-decision/types.ts";
import { createDeferred } from "../helpers/promise.js";

const message = "Use B for campaign X.";
const candidate = '{"kind":"directive","activityId":"campaign-x","direction":"B"}';
function requiredEntry<T>(entries: readonly T[], index: number): T {
  const entry = entries[index];
  if (entry === undefined) {
    throw new Error("Expected test entry at index " + index + ".");
  }
  return entry;
}
function hostState(): HostState {
  const activities: HostState["activities"] = [
    { id: "campaign-x", label: "campaign X", currentDirection: "A", destinationId: "company" },
    { id: "campaign-y", label: "campaign Y", currentDirection: "A", destinationId: "family" },
  ];
  return {
    actorId: "synthetic-owner",
    sourceId: "home",
    decisionGrants: activities.map((a) => a.id),
    activities,
    releases: activities.map((a) => ({
      id: "release-" + a.id,
      sourceId: "home",
      activityId: a.id,
      destinationId: a.destinationId,
      directions: ["A", "B"],
      allowed: true,
      importAllowed: true,
    })),
  };
}
function example(route = explicitCommandRoute(), host = hostState(), inputMessage = message) {
  return runCase({ id: "synthetic-case", message: inputMessage, host: () => host, route });
}
type HostChange = { name: string; change: (host: HostState) => void; reason: string };
const deniedPolicies: HostChange[] = [
  {
    name: "decision authority",
    change: (h) => {
      h.decisionGrants = [];
    },
    reason: "decision-authority-denied",
  },
  {
    name: "source release",
    change: (h) => {
      requiredEntry(h.releases, 0).allowed = false;
    },
    reason: "disclosure-denied-or-ambiguous",
  },
  {
    name: "destination import",
    change: (h) => {
      requiredEntry(h.releases, 0).importAllowed = false;
    },
    reason: "disclosure-denied-or-ambiguous",
  },
  {
    name: "direction-specific release",
    change: (h) => {
      requiredEntry(h.releases, 0).directions = ["A"];
    },
    reason: "disclosure-denied-or-ambiguous",
  },
  {
    name: "ambiguous release",
    change: (h) => {
      h.releases.push({ ...requiredEntry(h.releases, 0), id: "second" });
    },
    reason: "disclosure-denied-or-ambiguous",
  },
];
describe("scoped decision experiment", () => {
  it("projects only relevant context and previews the exact authorized directive", async () => {
    const classify = vi
      .fn<ClassifierRoute["classify"]>()
      .mockResolvedValue({ text: candidate, modelCalls: 0, physicalProviderRequests: 0 });
    const result = await example({ name: "captured", kind: "replay", classify });
    expect(classify).toHaveBeenCalledExactlyOnceWith({
      message,
      activities: [
        { id: "campaign-x", label: "campaign X", currentDirection: "A" },
        { id: "campaign-y", label: "campaign Y", currentDirection: "A" },
      ],
    });
    const preview = {
      activityId: "campaign-x",
      destinationId: "company",
      policyId: "release-campaign-x",
      payload: { kind: "direction-update", activityId: "campaign-x", direction: "B" },
      text: "Use B for campaign-x.",
    };
    expect(result.gate.outcome).toBe("authorization-preview");
    expect(result.preview).toEqual(preview);
    expect(result.metrics).toMatchObject({
      modelCalls: 0,
      physicalProviderRequests: 0,
      usage: null,
      inlineModelOverhead: null,
    });
  });

  it.each([
    "Don't use B for campaign X.",
    '"Use B for campaign X."',
    "Maybe we should use B for campaign X.",
    "Use B for campaign X. Keep PRIVATE_RATIONALE_CANARY local.",
  ])("cannot turn unsupported wording into authority: %s", async (inputMessage) => {
    const result = await example(replayRoute("mistaken", candidate), hostState(), inputMessage);
    expect(result.gate.reason).toBe("instruction-not-explicitly-scoped");
    expect(result.preview).toBeNull();
    expect(JSON.stringify(result)).not.toContain("PRIVATE_RATIONALE_CANARY");
  });

  it.each([
    '{"kind":"directive","activityId":"campaign-y","direction":"B"}',
    '{"kind":"directive","activityId":"campaign-x","direction":"A"}',
  ])("rejects a different otherwise-authorized target or direction: %s", async (text) => {
    expect(
      (await example(explicitCommandRoute(), hostState(), "Use B for campaign Y.")).preview,
    ).not.toBeNull();
    const result = await example(replayRoute("wrong-selection", text));
    expect(result.gate.reason).toBe("candidate-does-not-match-instruction");
    expect(result.preview).toBeNull();
  });

  it("does not let a classifier resolve an ambiguous activity label", async () => {
    const host = hostState();
    requiredEntry(host.activities, 1).label = requiredEntry(host.activities, 0).label;
    const result = await example(replayRoute("guessed", candidate), host);
    expect(result.gate.reason).toBe("instruction-not-explicitly-scoped");
    expect(result.preview).toBeNull();
  });

  it.each(deniedPolicies)("independently enforces $name", async ({ change, reason }) => {
    const host = hostState();
    change(host);
    const result = await example(replayRoute("positive", candidate), host);
    expect(result.gate.reason).toBe(reason);
    expect(result.preview).toBeNull();
  });

  it.each<HostChange>([
    ...deniedPolicies,
    {
      name: "actor replacement",
      change: (h) => {
        h.actorId = "other";
      },
      reason: "host-binding-changed",
    },
    {
      name: "source replacement",
      change: (h) => {
        h.sourceId = "other";
      },
      reason: "host-binding-changed",
    },
    {
      name: "same-ID activity label replacement",
      change: (h) => {
        h.activities[0] = { ...requiredEntry(h.activities, 0), label: "replacement" };
      },
      reason: "host-binding-changed",
    },
    {
      name: "destination replacement",
      change: (h) => {
        requiredEntry(h.activities, 0).destinationId = "other";
      },
      reason: "host-binding-changed",
    },
  ])("rereads $name after classification waits", async ({ change, reason }) => {
    const host = hostState();
    const pending = createDeferred<ClassifierObservation>();
    const classify = vi.fn<ClassifierRoute["classify"]>().mockReturnValue(pending.promise);
    const resultPromise = example({ name: "delayed", kind: "replay", classify }, host);
    expect(classify).toHaveBeenCalledOnce();
    change(host);
    pending.resolve({ text: candidate, modelCalls: 0, physicalProviderRequests: 0 });
    const result = await resultPromise;
    expect(result.gate.reason).toBe(reason);
    expect(result.preview).toBeNull();
  });

  it.each([
    {
      name: "decision revoke then regrant",
      change: (h: HostState) => {
        h.decisionGrants = [];
        h.decisionGrants = ["campaign-x"];
      },
    },
    {
      name: "release revoke then regrant",
      change: (h: HostState) => {
        requiredEntry(h.releases, 0).allowed = false;
        requiredEntry(h.releases, 0).allowed = true;
      },
    },
    {
      name: "equivalent same-ID activity and policy replacements",
      change: (h: HostState) => {
        h.activities = structuredClone(h.activities);
        h.releases = structuredClone(h.releases);
      },
    },
  ])(
    "previews current permission after $name without claiming lifetime continuity",
    async ({ change }) => {
      const host = hostState();
      const pending = createDeferred<ClassifierObservation>();
      const classify = vi.fn<ClassifierRoute["classify"]>().mockReturnValue(pending.promise);
      const resultPromise = example({ name: "delayed", kind: "replay", classify }, host);
      expect(classify).toHaveBeenCalledOnce();
      change(host);
      const current = structuredClone(host);
      pending.resolve({ text: candidate, modelCalls: 0, physicalProviderRequests: 0 });
      const result = await resultPromise;
      expect(result.gate.outcome).toBe("authorization-preview");
      expect(result.preview?.payload).toEqual({
        kind: "direction-update",
        activityId: "campaign-x",
        direction: "B",
      });
      expect(host).toEqual(current);
    },
  );

  it.each([
    "not JSON",
    '{"kind":"directive","activityId":"campaign-x","direction":"B","sharingPolicy":"public"}',
    '{"kind":"directive","activityId":"campaign-x","direction":"C"}',
    "x".repeat(2049),
  ])("rejects malformed or permission-bearing output", async (text) => {
    const result = await example(replayRoute("invalid", text));
    expect(result.gate.reason).toBe("candidate-malformed");
    expect(result.preview).toBeNull();
  });

  it("rejects oversized context before calling a classifier and handles stop separately", async () => {
    const classify = vi.fn<ClassifierRoute["classify"]>();
    const route: ClassifierRoute = { name: "unused", kind: "replay", classify };
    expect((await example(route, hostState(), "x".repeat(4097))).gate.reason).toBe(
      "invalid-or-unavailable-host-input",
    );
    expect((await example(route, hostState(), "Stop campaign X now.")).gate).toEqual({
      outcome: "stop-observed",
      reason: "actual-interrupt-not-implemented",
    });
    expect(classify).not.toHaveBeenCalled();
  });

  it("keeps classifier mistakes, missed progress and simulated safety separate", async () => {
    const report = await runExperiment(fixtures);
    expect(report.effect).toBe("authorization-preview-only");
    for (const route of report.routes) {
      expect(route.metrics.unsafePreviews).toBe(0);
      expect(route.metrics.authorizationPreviews).toBeGreaterThan(0);
      expect(route.metrics.modelCalls.knownTotal).toBe(0);
      expect(route.metrics.usage.totalTokens.observedSamples).toBe(0);
      expect(route.records.every((r) => r.metrics.inlineModelOverhead === null)).toBe(true);
    }
    const baseline = requiredEntry(report.routes, 0);
    const replay = requiredEntry(report.routes, 1);
    expect(baseline.metrics.missedPreviews).toBe(0);
    expect(replay.metrics.rawClassificationErrors).toBeGreaterThan(0);
    expect(replay.metrics.rawTargetErrors).toBeGreaterThan(0);
    expect(replay.metrics.missedPreviews).toBeGreaterThan(0);
  });

  it("does not turn failed separate inference into measured zero usage", async () => {
    const result = await example({
      name: "failed",
      kind: "separate-completion",
      classify: async () => {
        throw new Error("PRIVATE_ERROR_CANARY");
      },
    });
    expect(result.gate.outcome).toBe("classifier-error");
    expect(result.metrics).toMatchObject({
      modelCalls: null,
      physicalProviderRequests: null,
      usage: null,
    });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_ERROR_CANARY");
  });
});
