import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { retainedPublicationArtifactSource } from "../../scripts/lib/release-evidence-identity.mjs";
import { validatePreparedNpmArtifactDescriptor } from "../../scripts/plugin-npm-prepared-release.mjs";
import { candidatePublicationFixture } from "./candidate-publication.test-support.js";
import { recoveryConsumptionFixture } from "./receipt-recovery.test-support.js";
const workflow = parse(readFileSync(".github/workflows/openclaw-release-publish.yml", "utf8"));
const step = workflow.jobs.resolve_release_target.steps.find((entry: { run?: string }) =>
  entry.run?.includes("const prepared = preparedDockerEvidenceFromFullRelease"),
);
const script = step.run.match(
  /node --input-type=module <<'NODE'\n([\s\S]*?const prepared = preparedDockerEvidenceFromFullRelease[\s\S]*?)\nNODE/u,
)?.[1];
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
const execute = new AsyncFunction(
  "appendFileSync",
  "readFileSync",
  "preparedDockerEvidenceFromFullRelease",
  "validatePreparedNpmArtifactDescriptor",
  "retainedPublicationArtifactSource",
  "process",
  script?.replace(/^import .*?;$/gmu, "") ?? 'throw new Error("missing parent snippet")',
);
it.each([false, true])(
  "parent preserves original npm descriptor when recovered=%s",
  async (recovered) => {
    const original = candidatePublicationFixture();
    const recovery = recoveryConsumptionFixture(original);
    const manifest = recovered
      ? recovery.manifest
      : { ...original.manifest, publicationArtifacts: recovery.recovery.publicationArtifacts };
    const output: string[] = [];
    await execute(
      (_path: string, text: string) => output.push(text),
      () => JSON.stringify(manifest),
      () => undefined,
      validatePreparedNpmArtifactDescriptor,
      retainedPublicationArtifactSource,
      {
        env: {
          RUNNER_TEMP: "/fixture",
          EXPECTED_SHA: original.c,
          GITHUB_REPOSITORY: original.repository,
          FULL_RELEASE_VALIDATION_RUN_ID: manifest.runId,
          FULL_RELEASE_VALIDATION_RUN_ATTEMPT: String(manifest.runAttempt),
          PLUGIN_PUBLISH_SCOPE: "all-publishable",
          PUBLISH_DOCKER_ONLY: "false",
          GITHUB_OUTPUT: "/output",
        },
      },
    );
    expect(output.join("")).toContain(
      "plugin_npm_artifact=" + JSON.stringify(manifest.publicationArtifacts!.pluginNpm),
    );
  },
);
