import { afterAll } from "vitest";
import { installSharedTestSetup } from "./setup.shared.js";

const testEnv = installSharedTestSetup();

afterAll(() => {
  testEnv.cleanup();
});
