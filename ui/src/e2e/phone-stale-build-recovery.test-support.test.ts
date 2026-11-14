import { access, rm } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { startPhoneProofServer } from "./login-gate-e2e.test-support.ts";

const { startProductionControlUiE2eServer, startCopiedProductionControlUiE2eServer } = vi.hoisted(
  () => ({
    startProductionControlUiE2eServer: vi.fn(),
    startCopiedProductionControlUiE2eServer: vi.fn(),
  }),
);

vi.mock("../test-helpers/control-ui-e2e.ts", async (original) => ({
  ...(await original<typeof import("../test-helpers/control-ui-e2e.ts")>()),
  startProductionControlUiE2eServer,
  startCopiedProductionControlUiE2eServer,
}));

async function expectPathMissing(targetPath: string): Promise<void> {
  await expect(access(targetPath)).rejects.toMatchObject({ code: "ENOENT" });
}

function requireBuildDir(buildDir: unknown): string {
  if (typeof buildDir !== "string" || !buildDir) {
    throw new Error("production server did not receive a build directory");
  }
  return buildDir;
}

describe.each([undefined, "/fixture/production-ui"])(
  "phone stale-build proof cleanup (production root: %s)",
  (productionRoot) => {
    const startServer = productionRoot
      ? startCopiedProductionControlUiE2eServer
      : startProductionControlUiE2eServer;
    const buildDirectory = (args: unknown[]) => requireBuildDir(args[productionRoot ? 1 : 0]);
    it("removes the allocated build directory when production startup fails", async () => {
      const startupError = new Error("production startup failed");
      let buildDir: string | undefined;
      startServer.mockImplementationOnce(async (...args: unknown[]) => {
        buildDir = buildDirectory(args);
        throw startupError;
      });

      try {
        await expect(startPhoneProofServer("phone-proof-build", productionRoot)).rejects.toBe(
          startupError,
        );
        await expectPathMissing(requireBuildDir(buildDir));
      } finally {
        if (buildDir) {
          await rm(buildDir, { force: true, recursive: true });
        }
      }
    });

    it("closes the production server and removes its build directory", async () => {
      const closeServer = vi.fn(async () => undefined);
      let buildDir: string | undefined;
      startServer.mockImplementationOnce(async (...args: unknown[]) => {
        buildDir = buildDirectory(args);
        return { baseUrl: "http://127.0.0.1:3210/", close: closeServer };
      });

      const server = await startPhoneProofServer("phone-proof-build", productionRoot);
      expect(server.baseUrl).toBe("http://127.0.0.1:3210/");
      const allocatedBuildDir = requireBuildDir(buildDir);
      await access(allocatedBuildDir);

      await server.close();

      expect(closeServer).toHaveBeenCalledTimes(1);
      await expectPathMissing(allocatedBuildDir);
    });
  },
);
