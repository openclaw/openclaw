import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocaleFinalizerHarness } from "./control-ui-locale-finalizer.test-support.js";

// GitHub scheduling/checkout/download and token services are local fixtures.
// Workflow conditions/order, source scripts, provider request serialization,
// output files, strict validation and publisher Git effects remain real.
describe.skipIf(process.platform === "win32")(
  "locale finalizer credentialed effect boundary",
  () => {
    const harness = createLocaleFinalizerHarness();
    beforeAll(() => harness.prepare());
    afterAll(() => harness.cleanup());
    const expectedDelta = ["localeWorkflowProof.edit", "localeWorkflowProof.add"];
    const translated = (
      result: Awaited<ReturnType<typeof harness.run>>,
      locale: string,
      key: string,
    ) =>
      result.memory(locale).find((entry) => entry.segment_id === "localeWorkflowProof." + key)
        ?.translated;
    const assertValidated = (result: Awaited<ReturnType<typeof harness.run>>) => {
      expect(result.failure).toBe("");
      expect(result.trace).toContainEqual({
        step: "Validate control UI locale refresh",
        status: 0,
      });
    };

    it("re-pins main after bootstrap checkout and publishes only refreshed output", async () => {
      const result = await harness.run({ publish: true, advanceDuringCheckout: true });
      assertValidated(result);
      expect(result.publication.branchExists, result.publication.summary).toBe(true);
      expect(result.sourceAtSetup).toBe(result.fresh);
      expect(result.admittedSource).toBe(result.fresh);
      expect(result.workerRequests).toHaveLength(1);
      expect(result.workerRequests[0]?.ids).toEqual([
        "localeWorkflowProof.keep",
        "localeWorkflowProof.edit",
        "localeWorkflowProof.remove",
      ]);
      expect(result.providerRequests).toHaveLength(21);
      expect(result.providerRequests[0]?.proof).toEqual({
        "localeWorkflowProof.edit": "New locale proof {name}",
        "localeWorkflowProof.add": "Latest locale proof",
      });
      for (const request of result.providerRequests) {
        expect(request.ids).toEqual(expectedDelta);
      }
      expect(translated(result, "sv", "keep")).toBe("worker::Keep locale proof");
      expect(translated(result, "sv", "edit")).toBe("finalizer::New locale proof {name}");
      expect(translated(result, "sv", "add")).toBe("finalizer::Latest locale proof");
      expect(translated(result, "sv", "remove")).toBeUndefined();
      expect(
        Object.fromEntries(
          result
            .publishedMemory("sv")
            .filter((entry) => entry.segment_id.startsWith("localeWorkflowProof."))
            .map((entry) => [entry.segment_id, entry.translated]),
        ),
      ).toEqual({
        "localeWorkflowProof.keep": "worker::Keep locale proof",
        "localeWorkflowProof.edit": "finalizer::New locale proof {name}",
        "localeWorkflowProof.add": "finalizer::Latest locale proof",
      });
      expect(result.publicationCalls.some((call) => call.startsWith("pr create "))).toBe(true);
      expect(result.publication.mergeCalls).toContain("--auto --squash --match-head-commit");
      expect(result.publication.mainHead).toBe(result.fresh);
    });

    it("still defers when main moves again after the warm checkout and catch-up", async () => {
      const result = await harness.run({
        publish: true,
        advanceDuringCheckout: true,
        advanceAfterCatchup: true,
      });
      assertValidated(result);
      expect(result.sourceAtSetup).toBe(result.fresh);
      expect(result.admittedSource).toBe(result.fresh);
      expect(translated(result, "sv", "add")).toBe("finalizer::Latest locale proof");
      expect(result.publication.mainHead).toBe(result.later);
      expect(result.publication.branchExists).toBe(false);
      expect(result.publication.summary).toContain(
        "Deferred stale generated output because generator inputs changed on main.",
      );
      expect(result.publicationCalls.some((call) => call.startsWith("pr create "))).toBe(false);
      expect(result.publication.mergeCalls).toBe("");
    });

    it.each([
      { change: undefined, expected: "worker::Keep locale proof", retranslatesKeep: false },
      {
        change: "glossary" as const,
        expected: "finalizer::Keep locale proof",
        retranslatesKeep: true,
      },
    ])(
      "preserves full-refresh effects with compatible/incompatible workers: $change",
      async ({ change, expected, retranslatesKeep }) => {
        const result = await harness.run({ fullRefresh: true, change });
        assertValidated(result);
        expect(result.workerRequests.flatMap((request) => request.ids)).toContain(
          "localeWorkflowProof.keep",
        );
        expect(
          result.providerRequests
            .flatMap((request) => request.ids)
            .includes("localeWorkflowProof.keep"),
        ).toBe(retranslatesKeep);
        expect(translated(result, "sv", "keep")).toBe(expected);
        // A forced replay of every worker would overwrite this compatible sibling.
        expect(translated(result, "fr", "keep")).toBe("canonical::Keep locale proof");
      },
    );

    it("keeps a new canonical correction through real catch-up output", async () => {
      const result = await harness.run({ change: "canonical" });
      assertValidated(result);
      for (const request of result.providerRequests) {
        expect(request.ids).toEqual(expectedDelta);
      }
      expect(translated(result, "sv", "keep")).toBe("Canonical correction");
      expect(translated(result, "sv", "edit")).toBe("finalizer::New locale proof {name}");
    });

    it.each([
      { repository: "fork/openclaw", ref: "refs/heads/main" },
      { repository: "openclaw/openclaw", ref: "refs/heads/topic" },
    ])(
      "rejects workflow provenance before credentialed effects: $repository $ref",
      async (provenance) => {
        const result = await harness.run({ ...provenance, publish: true });
        expect(result.states["resolve-base"]?.result).toBe("skipped");
        expect(result.providerRequests).toEqual([]);
        expect(result.workerRequests).toEqual([]);
        expect(result.publicationCalls).toEqual([]);
        expect(result.publication.branchExists).toBe(false);
      },
    );

    it("propagates failed publisher admission before any provider/publication effects", async () => {
      const result = await harness.run({ preflightAllowed: false, publish: true });
      expect(result.states["publisher-preflight"]?.result).toBe("failure");
      expect(result.states.refresh?.result).toBe("skipped");
      expect(result.states.finalize?.result).toBe("skipped");
      expect(result.failure).toContain("Repository auto-merge must be enabled");
      expect(result.workerRequests).toEqual([]);
      expect(result.providerRequests).toEqual([]);
      expect(result.publicationCalls).toEqual([]);
    });

    it.each([
      ["foreign-run", "does not belong to this source and workflow attempt"],
      ["path", "invalid or duplicate memory path"],
      ["fallback", "fallback-containing locale artifact"],
    ] as const)(
      "rejects %s at the restore CLI before finalizer provider/publication I/O",
      async (artifactFault, error) => {
        const result = await harness.run({ artifactFault, publish: true });
        expect(result.workerRequests.length).toBeGreaterThan(0);
        expect({
          providerRequests: result.providerRequests.length,
          publicationCalls: result.publicationCalls.length,
          publishedBranch: result.publication.branchExists,
        }).toEqual({ providerRequests: 0, publicationCalls: 0, publishedBranch: false });
        expect(result.trace).toContainEqual({ step: "Restore same-run locale memory", status: 1 });
        expect(result.failure).toContain(error);
        expect(result.trace).toContainEqual({
          step: "Finalize control UI generated artifacts",
          status: "skipped",
        });
      },
    );
  },
);
