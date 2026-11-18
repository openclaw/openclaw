import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
import {
  selectStableReleaseSource,
  validateStableReleaseSource,
} from "../../scripts/stable-release-source.mjs";

const targetSha = "1".repeat(40);
const sourceSha = "2".repeat(40);
const dispatchId = "compatibility-fixture";
const tag = "v2026.11.5";
const selection = { schema: 1, targetSha, dispatchId, tag, sourceSha };

describe("stable-release-source compatibility", () => {
  it.each([false, true])(
    "pins the published tag, never target_commitish (annotated=%s)",
    async (annotated) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({
          draft: false,
          prerelease: false,
          tag_name: tag,
          target_commitish: "main",
        })
        .mockResolvedValueOnce({
          object: {
            type: annotated ? "tag" : "commit",
            sha: annotated ? "3".repeat(40) : sourceSha,
          },
        });
      if (annotated) {
        request.mockResolvedValueOnce({ object: { type: "commit", sha: sourceSha } });
      }
      expect(await selectStableReleaseSource({ targetSha, dispatchId, request })).toEqual(
        selection,
      );
      expect(request).toHaveBeenCalledTimes(annotated ? 3 : 2);
      expect(request.mock.calls[1]?.[0]).toContain("/git/ref/tags/" + tag);
    },
  );

  it.each([
    { draft: true },
    { prerelease: true },
    { tag_name: "v2026.11.5-beta.1" },
    { tag_name: "v2026.11.5\n" },
  ])("rejects unpublished or nonstable selection %j", async (invalid) => {
    const request = vi
      .fn()
      .mockResolvedValue({ draft: false, prerelease: false, tag_name: tag, ...invalid });
    await expect(selectStableReleaseSource({ targetSha, dispatchId, request })).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("restores the exact candidate-bound pin and refuses another request", () => {
    expect(validateStableReleaseSource(selection, targetSha, dispatchId)).toEqual(selection);
    expect(() => validateStableReleaseSource(selection, "4".repeat(40), dispatchId)).toThrow();
    expect(() => validateStableReleaseSource(selection, targetSha, "other-request")).toThrow();
    expect(() =>
      validateStableReleaseSource({ ...selection, sourceSha: "main" }, targetSha, dispatchId),
    ).toThrow();
  });

  it("dispatches both platforms from one selection and builds only the pinned client checkout", () => {
    const workflow = parse(
      readFileSync(".github/workflows/stable-release-source-compatibility.yml", "utf8"),
    );
    for (const platform of ["ios", "android"]) {
      expect(workflow.jobs[platform].needs).toBe("select");
      expect(workflow.jobs[platform].with.client_sha).toBe("${{ needs.select.outputs.sha }}");
      const child = parse(readFileSync(`.github/workflows/${platform}-release-e2e.yml`, "utf8"));
      expect(child.on.workflow_dispatch.inputs.client_sha).toMatchObject({
        type: "string",
        default: "",
      });
      expect(child.on.workflow_dispatch.inputs.client_release_tag).toMatchObject({
        type: "string",
        default: "",
      });
      const steps = child.jobs.qualify.steps;
      const pairStart = steps[0].run.indexOf('if [[ -n "$CLIENT_SHA"');
      expect(pairStart).toBeGreaterThanOrEqual(0);
      const pairCheck = steps[0].run.slice(pairStart);
      for (const [sha, releaseTag, status] of [
        ["", "", 0],
        [sourceSha, tag, 0],
        ["", tag, 1],
        [sourceSha, "", 1],
      ] as const) {
        expect(
          spawnSync("bash", ["-c", pairCheck], {
            env: { ...process.env, CLIENT_SHA: sha, CLIENT_RELEASE_TAG: releaseTag },
          }).status,
        ).toBe(status);
      }
      expect(
        steps.find(
          (step: { name?: string }) => step.name === "Checkout frozen stable client source",
        ).with,
      ).toMatchObject({
        ref: "${{ inputs.client_sha }}",
        path: ".openclaw/tmp/stable-client",
        "persist-credentials": false,
      });
      expect(
        steps.find((step: { name?: string }) => step.name === "Prepare stable Gateway selection")
          .if,
      ).toBe("inputs.client_sha == ''");
      const run = steps.find((step: { name?: string }) => step.name?.startsWith("Qualify ")).run;
      expect(run).toContain("--client-root");
      expect(run).toContain("--client-sha");
      expect(run).toContain("--client-release-tag");
    }
  });
});
