import { describe, expect, it, vi } from "vitest";
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
});
