import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as gatewayBindings from "../../daemon/managed-gateway-bindings.js";
import type { GatewayService } from "../../daemon/service.js";
import {
  createMockGatewayService,
  mockSystemAccountHome,
} from "../../daemon/service.test-helpers.js";
import * as serviceFiles from "../../daemon/systemd-service-files.js";
import * as gatewayLocks from "../../infra/gateway-lock.js";
import { mockProcessPlatform } from "../../test-utils/vitest-spies.js";
import { withServiceHome } from "./update-command-service-home.test-support.js";
import { withGatewayRuntimeArtifactPublication } from "./update-command-service-publication.js";

const mocks = vi.hoisted(() => ({ service: vi.fn<() => GatewayService>() }));
vi.mock("../../daemon/service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../daemon/service.js")>()),
  resolveGatewayService: mocks.service,
}));
beforeEach(() => mockSystemAccountHome());
afterEach(() => vi.restoreAllMocks());

it.each(["disjoint", "overlapping", "unknown", "retargeted"] as const)(
  "uses only loaded artifact locations when service credentials are unreadable: %s",
  (location) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      const root = path.join(home, "checkout");
      const serving = location === "overlapping" ? root : path.join(home, "serving");
      for (const directory of new Set([root, serving])) {
        await fs.mkdir(path.join(directory, "dist"), { recursive: true });
        await fs.writeFile(
          path.join(directory, "package.json"),
          JSON.stringify({ name: "openclaw" }),
        );
        await fs.writeFile(path.join(directory, "dist", "entry.js"), "export {};\n");
      }
      const denied = Object.assign(new Error("protected service environment"), { code: "EACCES" });
      const service = createMockGatewayService({
        readCommand: vi.fn(async () => {
          throw denied;
        }),
      });
      mocks.service.mockReturnValue(service);
      vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockResolvedValue([
        { env: { OPENCLAW_SYSTEMD_UNIT: "unloaded-user" } },
        {
          env: { OPENCLAW_SYSTEMD_UNIT: "loaded-system" },
          systemdReadTarget: {
            scope: "system",
            unitName: "loaded-system",
            unitPath: "/fixture/unit",
          },
        },
      ]);
      let retargeted = false;

      const readLocation = vi.spyOn(serviceFiles, "readSystemdServiceCommandLocation");
      if (location === "unknown") {
        readLocation.mockRejectedValue(new Error("loaded command unavailable"));
      } else {
        readLocation.mockImplementation(async (env) =>
          env.OPENCLAW_SYSTEMD_UNIT === "unloaded-user"
            ? { kind: "not-loaded" }
            : {
                kind: "command",
                command: {
                  programArguments: [
                    process.execPath,
                    path.join(retargeted ? root : serving, "dist", "entry.js"),
                    "gateway",
                  ],
                },
              },
        );
      }
      vi.spyOn(gatewayLocks, "readActiveGatewayLockIdentity").mockResolvedValue(undefined);
      const effect = vi.fn(async (assertCurrent: () => Promise<void>) => {
        retargeted = location === "retargeted";
        await assertCurrent();
        return "published";
      });
      const publication = withGatewayRuntimeArtifactPublication(
        { root, env: { ...process.env }, timeoutMs: 1_000, assertCurrent() {} },
        effect,
      );
      if (location === "disjoint") {
        await expect(publication).resolves.toBe("published");
        expect(effect).toHaveBeenCalledOnce();
        expect(service.readCommand).not.toHaveBeenCalled();
      } else {
        await expect(publication).rejects.toMatchObject({
          reason: "runtime-artifact-publication",
          cause: denied,
        });
        expect(effect).toHaveBeenCalledTimes(location === "retargeted" ? 1 : 0);
      }
      for (const mutation of [service.stop, service.start, service.restart, service.install]) {
        expect(mutation).not.toHaveBeenCalled();
      }
    }),
);

it.each(["overlapping", "unknown", "incomplete inventory", "recovered disjoint"] as const)(
  "does not lose unsafe sibling evidence behind a readable disjoint invoking service: %s",
  (scenario) =>
    withServiceHome(async (home) => {
      mockProcessPlatform("linux");
      const root = path.join(home, "checkout");
      const invoking = path.join(home, "invoking");
      for (const directory of [root, invoking]) {
        await fs.mkdir(path.join(directory, "dist"), { recursive: true });
        await fs.writeFile(path.join(directory, "package.json"), '{"name":"openclaw"}');
        await fs.writeFile(path.join(directory, "dist", "entry.js"), "export {};");
      }
      const command = (directory: string) => ({
        programArguments: [process.execPath, path.join(directory, "dist", "entry.js"), "gateway"],
      });
      const env = { ...process.env };
      const target = {
        scope: "system" as const,
        unitName: "sibling",
        unitPath: "/fixture/sibling",
      };
      const sibling = { env: { OPENCLAW_SYSTEMD_UNIT: "sibling" }, systemdReadTarget: target };
      const denied = Object.assign(new Error("protected sibling environment"), { code: "EACCES" });
      const service = createMockGatewayService({
        readCommand: vi.fn(async (serviceEnv) => {
          if (
            serviceEnv?.OPENCLAW_SYSTEMD_UNIT === "sibling" &&
            scenario !== "recovered disjoint"
          ) {
            throw denied;
          }
          return command(invoking);
        }),
        readRuntime: vi.fn(async () => ({ status: "running", systemd: { managerUid: 2001 } })),
        isLoaded: vi.fn(async () => true),
      });
      mocks.service.mockReturnValue(service);
      vi.spyOn(gatewayBindings, "discoverManagedGatewayBindings").mockImplementation(
        async (_env, options) => {
          if (scenario === "incomplete inventory") {
            if (options?.requireComplete) {
              throw new Error("Managed Gateway inventory could not be completely inspected.");
            }
            return [];
          }
          return [...(options?.includeInvoking ? [{ env }] : []), sibling];
        },
      );
      const readLocation = vi
        .spyOn(serviceFiles, "readSystemdServiceCommandLocation")
        .mockImplementation(async (_env, readTarget) => {
          if (readTarget === target) {
            if (scenario === "unknown" || scenario === "recovered disjoint") {
              throw new Error("sibling location unavailable");
            }
            return { kind: "command", command: command(root) };
          }
          return { kind: "command", command: command(invoking) };
        });
      vi.spyOn(gatewayLocks, "readActiveGatewayLockIdentity").mockResolvedValue(undefined);
      const effect = vi.fn(async () => "published");
      const publication = withGatewayRuntimeArtifactPublication(
        { root, env, timeoutMs: 1_000, assertCurrent() {} },
        effect,
      );
      if (scenario === "recovered disjoint") {
        await expect(publication).resolves.toBe("published");
        expect(effect).toHaveBeenCalledOnce();
      } else {
        await expect(publication).rejects.toMatchObject({ reason: "runtime-artifact-publication" });
        expect(effect).not.toHaveBeenCalled();
      }
      if (scenario !== "incomplete inventory") {
        expect(readLocation).toHaveBeenCalledWith(sibling.env, target);
        expect(service.readCommand).toHaveBeenCalledWith(
          sibling.env,
          expect.objectContaining({ systemdReadTarget: target }),
        );
      }
      for (const mutation of [service.stop, service.start, service.restart, service.install]) {
        expect(mutation).not.toHaveBeenCalled();
      }
    }),
);
