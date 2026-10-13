// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { describe, expect, it } from "vitest";
import { registerManagedTerminalResultTests } from "./update-managed-service-handoff-result.test-support.js";

const { runManagedServiceManagerBoundary, tempDirs } = useManagedServiceHandoffLifecycleFixture();

describe("managed service update handoff", () => {
  const itUnix = it.runIf(process.platform !== "win32");

  registerManagedTerminalResultTests(runManagedServiceManagerBoundary, itUnix, expect, tempDirs);
});
