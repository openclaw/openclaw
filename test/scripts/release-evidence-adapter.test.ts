import { expect, it, vi } from "vitest";
const { validate } = vi.hoisted(() => ({ validate: vi.fn() }));
vi.mock("../../scripts/lib/full-release-child-reuse.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../scripts/lib/full-release-child-reuse.mjs")>()),
  validateReusableReleaseChild: validate,
}));
import { createReleaseEvidenceClient } from "../../scripts/release-ci-summary.mjs";
it("forwards the recovery deadline through the real evidence adapter without caching", async () => {
  const selection = { runId: "10" };
  const request = { repository: "openclaw/openclaw" };
  const options = { deadlineMs: Date.now() + 600_000 };
  validate.mockResolvedValueOnce({ first: true }).mockResolvedValueOnce({ second: true });
  const client = createReleaseEvidenceClient();
  await expect(client.validateChildReuse(selection, request, options)).resolves.toEqual({
    first: true,
  });
  await expect(client.validateChildReuse(selection, request, options)).resolves.toEqual({
    second: true,
  });
  expect(validate.mock.calls).toEqual([
    [selection, request, options],
    [selection, request, options],
  ]);
});
