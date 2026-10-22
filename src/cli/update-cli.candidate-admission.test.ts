import { describe, vi } from "vitest";
import * as assertions from "./update-cli-assertions.test-support.js";
import { createUpdateCliFixture } from "./update-cli-fixture.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as modules from "./update-cli-modules.test-support.js";
import { registerCandidateAdmissionTests } from "./update-cli/update-command-candidate-admission.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

describe("update-cli", () => {
  const fixture = createUpdateCliFixture();
  registerCandidateAdmissionTests({
    ...fixture,
    ...mocks,
    ...modules,
    ...assertions,
    makeTempDir: (prefix) => fixture.tempDirs.make(prefix),
  });
});
