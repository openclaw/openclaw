/** Prompt fixture for interactive Doctor service repair. */
import { expect, it, vi, type Mock } from "vitest";
import * as runtimePaths from "../daemon/runtime-paths.js";
import type { GatewayService } from "../daemon/service-types.js";
import * as sqliteLibrary from "../infra/bun-sqlite-library.js";
import { buildGatewayInstallPlan } from "./daemon-install-helpers.js";
import { createDoctorPrompter } from "./doctor-prompter.js";
import { resolveGatewayInstallToken } from "./gateway-install-token.js";

export const doctorSqliteDiagnostic =
  "SQLite (doctor process): /fixture/libsqlite3.dylib (3.53.4, extension loading enabled)";

export function mockDoctorRuntimeFacts(runExec: Mock<typeof import("../process/exec.js").runExec>) {
  runExec.mockReset().mockImplementation(async (executable: string) => ({
    stdout: JSON.stringify({
      nodeVersion: "26.8.1",
      bunVersion: /(?:^|[/\\])bun(?:\.exe)?$/i.test(executable) ? "1.4.2" : null,
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
    }),
    stderr: "",
  }));
  vi.spyOn(runtimePaths, "resolvePreferredNodePath").mockResolvedValue("/opt/available/bin/node");
  vi.spyOn(sqliteLibrary, "ensureSqliteLibrarySelected").mockReturnValue({
    source: "env",
    path: "/fixture/libsqlite3.dylib",
    version: "3.53.4",
    extensionLoadingSupported: true,
  });
}

export function createPrompter(confirmImpl: (message: string) => boolean) {
  return {
    confirm: vi.fn(),
    confirmAutoFix: vi.fn(),
    confirmAggressiveAutoFix: vi.fn(),
    confirmRuntimeRepair: vi.fn(async ({ message }: { message: string }) => confirmImpl(message)),
    select: vi.fn(),
    shouldRepair: false,
    shouldForce: false,
    repairMode: {
      shouldRepair: false,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

export function setPlatform(platform: NodeJS.Platform) {
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  if (!originalPlatformDescriptor) {
    return;
  }
  Object.defineProperty(process, "platform", {
    ...originalPlatformDescriptor,
    value: platform,
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
    Object.defineProperty(process.versions, "bun", { configurable: true, value: "1.4.2" });
    const discoverNode = vi
      .spyOn(runtimePaths, "resolvePreferredNodePath")
      .mockResolvedValue(undefined);
    const probeBun = vi.spyOn(runtimePaths, "resolveBunRuntimeInfo").mockResolvedValue({
      status: "supported",
      version: "1.4.2",
      sqliteVersion: "3.53.4",
      sqliteProbe: { available: true, version: "3.53.4", text: true, blob: true, json: true },
      nodeSharedSqlite: false,
    });
    setPlatform("linux");
    vi.mocked(service.isLoaded).mockResolvedValue(false);
    vi.mocked(service.readRuntime).mockResolvedValue({ status: "stopped" });
    vi.mocked(resolveGatewayInstallToken).mockResolvedValueOnce({ warnings: [] });
    vi.mocked(buildGatewayInstallPlan).mockResolvedValueOnce({
      runtime: "bun",
      programArguments: [],
      environment: {},
    });
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
      expect(selection?.runtime).toBe("bun");
      expect(selection?.runtimeExplicit).toBe(true);
      expect(selection?.runtimePath).toBe(process.execPath);
      expect(selection?.pinnedRuntimePath).toBeUndefined();
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
