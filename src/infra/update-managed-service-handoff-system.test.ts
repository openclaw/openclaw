// Register process and coordinator mocks before the boundary imports their owners.
// oxfmt-ignore
import { useManagedServiceHandoffLifecycleFixture } from "./update-managed-service-handoff-fixture.test-support.js";
import { afterEach, expect, it, vi } from "vitest";
import * as systemdScope from "../daemon/systemd-scope.js";

const { runManagedServiceManagerBoundary } = useManagedServiceHandoffLifecycleFixture();
afterEach(() => vi.restoreAllMocks());

it.runIf(process.platform !== "win32")(
  "lets an admitted system-service updater settle without killing it or its Gateway",
  async () => {
    vi.spyOn(systemdScope, "findSystemdGatewayInstallation").mockResolvedValue({
      kind: "system",
      system: {
        scope: "system",
        unitName: "openclaw-production.service",
        unitPath: "/etc/systemd/system/openclaw-production.service",
      },
    });
    const result = await runManagedServiceManagerBoundary("systemd", {
      systemScope: true,
      ledger: true,
      controlDisconnect: "transferred",
      cancelDuringValidation: true,
      validationResult: "skipped",
    });
    expect(result.run).toMatchObject({ status: "skipped", reason: "already-current" });
    expect(result.run?.steps).toContainEqual(
      expect.objectContaining({
        step: "warning:managed-service-reconciliation",
        detail: expect.stringContaining("sudo systemctl restart openclaw-production.service"),
      }),
    );
    expect(result.commands).toEqual([]);
    expect(result.parentSignal).toBeNull();
    expect(result.log).toContain("managed update update command exited code=0 signal=null");
  },
);
