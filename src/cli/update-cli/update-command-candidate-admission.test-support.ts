import { expect, it } from "vitest";
import {
  createCandidateAdmissionFixtures,
  type CandidateAdmissionFixture,
} from "./update-command-candidate-admission-fixture.test-support.js";
import * as runtimeRecovery from "./update-command-runtime-recovery.test-support.js";

export function registerCandidateAdmissionTests(f: CandidateAdmissionFixture) {
  const {
    nodeVersionSatisfiesEngine,
    invokeUpdateCli,
    lastWriteJsonCall,
    expectNoSideEffects,
    serviceStop,
    candidateCheck,
  } = f;

  const { prepareCandidateAdmissionFixture, candidateAdmissionVerdict } =
    createCandidateAdmissionFixtures(f);
  const prepare = () =>
    prepareCandidateAdmissionFixture({ marker: true, verdict: candidateAdmissionVerdict() });
  const update = (options: Parameters<typeof invokeUpdateCli>[0] = {}) =>
    invokeUpdateCli({ admission: "auto", yes: true, restart: false, json: true, ...options });

  it("candidate admission: keeps dry-run on installed checks without staging", async () => {
    runtimeRecovery.stubNodeRuntime();
    const { stages, contexts } = await prepare();
    nodeVersionSatisfiesEngine.mockReturnValue(false);

    await update({ restart: undefined, dryRun: true });

    expect(stages).toEqual([]);
    expect(contexts).toEqual([]);
    expect(lastWriteJsonCall()).toMatchObject({
      dryRun: true,
      failures: expect.arrayContaining([
        expect.objectContaining({ reason: "preflight-node-runtime-incompatible" }),
      ]),
    });
    expectNoSideEffects(serviceStop, candidateCheck);
  });
}
