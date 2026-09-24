import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { expect } from "vitest";

export async function expectSavedOriginalFilenameCase(
  store: typeof import("./store.js"),
  params: {
    originalFilename?: string;
    expectedIdPattern: RegExp;
    expectedExtractedFilename?: string;
    expectUuidOnly?: boolean;
    maxBaseNameLength?: number;
  },
) {
  const saved = await store.saveMediaBuffer(
    Buffer.from("test content"),
    "text/plain",
    "inbound",
    5 * 1024 * 1024,
    params.originalFilename,
  );

  expect(saved.id).toMatch(params.expectedIdPattern);
  if (params.expectedExtractedFilename) {
    expect(store.extractOriginalFilename(saved.path)).toBe(params.expectedExtractedFilename);
  }
  if (params.expectUuidOnly) {
    expect(saved.id).not.toContain("---");
  }
  if (params.maxBaseNameLength !== undefined) {
    const baseName = expectDefined(
      path.parse(saved.id).name.split("---")[0],
      'path.parse(saved.id).name.split("---")[0] test invariant',
    );
    expect(baseName.length).toBeLessThanOrEqual(params.maxBaseNameLength);
  }
}
