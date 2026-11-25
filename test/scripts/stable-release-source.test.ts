import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  selectStableReleaseSource,
  validateStableReleaseSource,
} from "../../scripts/stable-release-source.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const targetSha = "1".repeat(40);
const sourceSha = "2".repeat(40);
const dispatchId = "compatibility-fixture";
const tag = "v2026.11.5";
const selection = { schema: 1, targetSha, dispatchId, tag, sourceSha };
const dirs = useAutoCleanupTempDirTracker(afterAll);

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

  it.each([sourceSha, "3".repeat(40)])(
    "verifies the frozen published release before client execution: %s",
    async (commit) => {
      const request = vi
        .fn()
        .mockResolvedValueOnce({ draft: false, prerelease: false, tag_name: tag })
        .mockResolvedValueOnce({ object: { type: "commit", sha: commit } });
      const result = selectStableReleaseSource({ targetSha, dispatchId, request, tag, sourceSha });
      if (commit === sourceSha) {
        await expect(result).resolves.toEqual(selection);
      } else {
        await expect(result).rejects.toThrow(/frozen/);
      }
      expect(request.mock.calls[0]?.[0]).toContain("/releases/tags/" + tag);
    },
  );

  it.each([
    "valid",
    "missing-tag",
    "missing-sha",
    "malformed",
    "prerelease",
    "restore",
    "lookup-failure",
    "mismatch",
  ])("CLI client preflight is fail-closed: %s", (scenario) => {
    const root = dirs.make("stable-client-preflight-");
    const bootstrap = path.join(root, "fetch.mjs");
    const output = path.join(root, "output");
    writeFileSync(
      bootstrap,
      `globalThis.fetch = async url => ({ ok: process.env.SCENARIO !== "lookup-failure", status: 404, json: async () => url.includes("/releases/") ? {draft: false, prerelease: false, tag_name: "${tag}"} : {object: {type: "commit", sha: process.env.SCENARIO === "mismatch" ? "${targetSha}" : "${sourceSha}"}} });`,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        bootstrap,
        "scripts/stable-release-source.mjs",
        "--verify-client",
        ...(scenario === "restore" ? ["--restore"] : []),
      ],
      {
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          GH_TOKEN: "",
          GITHUB_OUTPUT: output,
          TARGET_SHA: targetSha,
          SCENARIO: scenario,
          CLIENT_SHA:
            scenario === "missing-sha" ? "" : scenario === "malformed" ? "main" : sourceSha,
          CLIENT_RELEASE_TAG:
            scenario === "missing-tag" ? "" : scenario === "prerelease" ? "v2026.11.5-beta.1" : tag,
        },
      },
    );
    expect([result.error, result.signal, result.status], result.stderr).toEqual([
      undefined,
      null,
      scenario === "valid" ? 0 : 1,
    ]);
    expect(existsSync(output)).toBe(scenario === "valid");
  });

  it("restores the exact candidate-bound pin and refuses another request", () => {
    expect(validateStableReleaseSource(selection, targetSha, dispatchId)).toEqual(selection);
    expect(() => validateStableReleaseSource(selection, "4".repeat(40), dispatchId)).toThrow();
    expect(() => validateStableReleaseSource(selection, targetSha, "other-request")).toThrow();
    expect(() =>
      validateStableReleaseSource({ ...selection, sourceSha: "main" }, targetSha, dispatchId),
    ).toThrow();
  });
});
