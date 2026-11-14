import { afterAll, beforeAll, expect, it } from "vitest";
import { captureFullEnv } from "../../test-utils/env.js";
import { useManagedWorktreeTestRepository } from "./service.test-support.js";

let originalEnvironment: NodeJS.ProcessEnv;
let snapshot: ReturnType<typeof captureFullEnv>;
let commonDirectory: string | undefined;
beforeAll(() => {
  originalEnvironment = process.env;
  snapshot = captureFullEnv();
  commonDirectory = process.env.GIT_COMMON_DIR;
});

useManagedWorktreeTestRepository();

afterAll(() => {
  try {
    expect(process.env.GIT_COMMON_DIR).toBe(commonDirectory);
  } finally {
    process.env = originalEnvironment;
    snapshot.restore();
  }
});

it("restores the active environment after its object is replaced", () => {
  process.env = { ...process.env, GIT_COMMON_DIR: "../synthetic-repository/.git" };
});
