import { expect, it, vi, type Mock } from "vitest";
import { runtimeFixture } from "../cli/update-cli/update-command-fixtures.test-support.js";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { GatewayService } from "../daemon/service-types.js";
import { createDoctorPrompterFixture as makePrompter } from "../flows/doctor-health-context.test-support.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

export function mockDoctorRuntimeFacts(runExec: Mock<typeof import("../process/exec.js").runExec>) {
  runExec.mockReset().mockImplementation(async (executable: string) => ({
    stdout: JSON.stringify({
      nodeVersion: "26.8.1",
      bunVersion: /(?:^|[/\\])bun(?:\.exe)?$/i.test(executable) ? "1.4.3" : null,
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    }),
    stderr: "",
  }));
  vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue("/opt/available/bin/node");
}

export function createPrompter(confirmImpl: (message: string) => boolean) {
  return {
    ...makePrompter(false, true),
    confirmRuntimeRepair: vi.fn(async ({ message }: { message: string }) => confirmImpl(message)),
    select: vi.fn(),
  };
}

export function setPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform });
}

export function mockGatewayInstall(
  service: Pick<GatewayService, "isLoaded" | "readRuntime">,
  programArguments: string[] = [],
  environment: Record<string, string> = {},
) {
  vi.mocked(service.isLoaded).mockResolvedValue(false);
  vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped" });
  vi.mocked(resolveGatewayInstallToken).mockResolvedValueOnce({ warnings: [] });
  vi.mocked(buildGatewayInstallPlan).mockResolvedValueOnce({
    runtime: "bun",
    programArguments,
    environment,
  });
}

export function registerRunningBunFallbackTest({
  runDoctor,
  service,
}: {
  runDoctor: (params: { prompter: ReturnType<typeof createPrompter> }) => Promise<void>;
  service: Pick<GatewayService, "isLoaded" | "readRuntime" | "install">;
}) {
  it("uses running Bun for the non-interactive runtime fallback on a Bun-only host", async () => {
    const bunVersion = Object.getOwnPropertyDescriptor(process.versions, "bun");
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.3" });
    const discoverNode = vi
      .spyOn(runtimePaths, "resolvePreferredNodePath")
      .mockResolvedValue(undefined);
    const probeBun = vi
      .spyOn(runtimePaths, "resolveBunRuntimeInfo")
      .mockResolvedValue(runtimeFixture("1.4.3", "3.53.4"));
    setPlatform("linux");
    mockGatewayInstall(service);
    // Service-install consent is separate from Doctor's --fix --non-interactive runtime selection.
    const prompter = createPrompter(() => true);
    prompter.select.mockImplementation(
      createDoctorPrompter({
        runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
        options: { repair: true, nonInteractive: true },
      }).select,
    );
    try {
      await runDoctor({ prompter });
      const selection = vi.mocked(buildGatewayInstallPlan).mock.calls[0]?.[0];
      expect(selection).toMatchObject({
        runtime: "bun",
        runtimeExplicit: true,
        runtimePath: process.execPath,
        pinnedRuntimePath: undefined,
      });
      expect(prompter.select).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ initialValue: "bun" }),
        "bun",
      );
      expect(service.install).toHaveBeenCalledOnce();
    } finally {
      discoverNode.mockRestore();
      probeBun.mockRestore();
      if (bunVersion) {
        Object.defineProperty(process.versions, "bun", bunVersion);
      } else {
        delete process.versions.bun;
      }
    }
  });
}
