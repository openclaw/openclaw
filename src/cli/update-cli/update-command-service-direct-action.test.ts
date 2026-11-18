import "./update-command-service-maintenance.test-support.js";
import path from "node:path";
import { expect, it, vi } from "vitest";
import * as schtasksExec from "../../daemon/schtasks-exec.js";
import { createMockGatewayService } from "../../daemon/service.test-helpers.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { maybeStopManagedServiceBeforeMutableUpdate } from "./update-command-service-maintenance.js";

const { mocks, withServiceHome } =
  await import("./update-command-service-maintenance.test-support.js");

it.each(["inspect", "prepare"] as const)(
  "keeps a directly registered Windows action outside mutable update admission (%s)",
  (phase) =>
    withServiceHome(async () => {
      mockProcessPlatform("win32");
      const native = vi
        .spyOn(schtasksExec, "execSchtasks")
        .mockRejectedValue(new Error("Unexpected native task mutation"));
      let running = true;
      const service = createMockGatewayService({
        readCommand: async () => ({
          programArguments: [process.execPath, path.join(process.cwd(), "openclaw.mjs"), "gateway"],
        }),
        isLoaded: async () => true,
        readRuntime: async () => ({ status: running ? "running" : "stopped" }),
        stop: vi.fn(async () => {
          running = false;
        }),
      });
      mocks.service.mockReturnValue(service);
      const result = await maybeStopManagedServiceBeforeMutableUpdate({
        root: process.cwd(),
        updateInstallKind: "package",
        shouldRestart: true,
        jsonMode: true,
        phase,
      });
      expect(result).toMatchObject({
        stopped: false,
        serviceMutationAllowed: false,
        serviceUpdateVerdict: { kind: "unavailable" },
      });
      expect(service.stop).not.toHaveBeenCalled();
      expect(service.restart).not.toHaveBeenCalled();
      expect(service.install).not.toHaveBeenCalled();
      expect(native).not.toHaveBeenCalled();
    }),
);
