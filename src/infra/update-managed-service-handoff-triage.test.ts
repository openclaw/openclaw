// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import { registerManagedUpdateHandoffTriageTests } from "./update-managed-service-handoff-triage.test-support.js";

const { runManagedServiceManagerBoundary } = useManagedServiceHandoffLifecycleFixture();

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  registerManagedUpdateHandoffTriageTests(runManagedServiceManagerBoundary, itUnix, expect);
});
