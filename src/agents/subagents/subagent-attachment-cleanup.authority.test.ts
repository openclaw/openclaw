import type { RootRemoveOptions } from "@openclaw/fs-safe/root";
import { beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { cleanupMaterializedSubagentAttachments } from "./subagent-attachment-cleanup.js";

const mocks = vi.hoisted(() => ({ root: vi.fn() }));
vi.mock("../../infra/fs-safe.js", async () => ({
  FsSafeError: (await import("@openclaw/fs-safe/errors")).FsSafeError,
  root: mocks.root,
}));
vi.mock("./subagent-attachment-paths.js", () => ({
  resolveSubagentSessionAttachmentRootDir: () => "/synthetic/attachments",
}));

const attachmentId = "11111111-1111-4111-8111-111111111111";
const childSessionKey = "agent:main:subagent:attachment-authority";
beforeEach(() => {
  mocks.root.mockReset();
});

it("does not admit attachment removal after its original owner loses cleanup authority", async () => {
  const remove = vi.fn(async () => {});
  mocks.root.mockResolvedValue({ remove });
  const request = { childSessionKey, attachmentId, isCurrent: () => false };
  await expect(cleanupMaterializedSubagentAttachments(request)).rejects.toThrow(
    "cleanup owner is no longer current",
  );
  expect(mocks.root).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
});

it.each([true, false])(
  "rechecks attachment cleanup authority at the maintained mutation boundary (current=%s)",
  async (remainsCurrent) => {
    const entered = createDeferred();
    const ready = createDeferred();
    const mutate = vi.fn();
    let current = true;
    const remove = vi.fn(async (_path: string, options: RootRemoveOptions = {}) => {
      entered.resolve();
      await ready.promise;
      options.assertBeforeMutation?.();
      mutate();
    });
    mocks.root.mockResolvedValue({ remove });
    const request = { childSessionKey, attachmentId, isCurrent: () => current };
    const operation = cleanupMaterializedSubagentAttachments(request);
    try {
      await entered.promise;
      current = remainsCurrent;
      const settled = remainsCurrent
        ? expect(operation).resolves.toBeUndefined()
        : expect(operation).rejects.toThrow("cleanup owner is no longer current");
      ready.resolve();
      await settled;
      expect(remove).toHaveBeenCalledExactlyOnceWith(
        attachmentId,
        expect.objectContaining({ recursive: true, force: true }),
      );
      expect(mutate).toHaveBeenCalledTimes(remainsCurrent ? 1 : 0);
    } finally {
      ready.resolve();
      await operation.catch(() => {});
    }
  },
);
