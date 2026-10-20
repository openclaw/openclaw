import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  makeDoctorIo,
  makeDoctorPrompts,
  pinSnapshotMock,
} from "./doctor-gateway-runtime.test-utils.js";
import { maybeRepairGatewayServiceConfig } from "./doctor-gateway-services.js";
import { fsMocks, mocks } from "./doctor-gateway-services.native.test-support.js";

await vi.hoisted(() => import("./doctor-gateway-services.native.test-support.js"));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  vi.clearAllMocks();
  pinSnapshotMock.mockReturnValue({ revision: "empty", stored: false });
  fsMocks.realpath.mockImplementation(async (value: string) => value);
  mocks.readRuntime.mockResolvedValue({ status: "unknown" });
  mocks.resolveNodeRuntimeInfo.mockResolvedValue({ status: "supported" });
  mocks.resolveGatewayAuthTokenForService.mockResolvedValue({});
  mocks.needsNodeRuntimeMigration.mockReturnValue(true);
});

it.each([
  { supported: false, approved: false },
  { supported: false, approved: true },
  { supported: true, approved: false },
])(
  "previews runtime and source findings before consent (supported=$supported, approved=$approved)",
  async ({ supported, approved }) => {
    let entrypoint = "/synthetic/openclaw/dist/index.js";
    if (!supported) {
      const root = tempDirs.make("openclaw-doctor-preview-");
      for (const directory of [".git", "src", "extensions", "dist"]) {
        await fs.mkdir(path.join(root, directory));
      }
      await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
      entrypoint = path.join(root, "dist", "index.js");
      await fs.writeFile(entrypoint, "export {};\n");
    }
    const node = "/home/test/.nvm/bin/node";
    const command = {
      programArguments: [node, entrypoint, "gateway"],
      environment: supported ? {} : { PATH: "/old/bin" },
    };
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockImplementation(async ({ runtimePath }) => ({
      ...command,
      programArguments: supported
        ? [runtimePath ?? node, ...command.programArguments.slice(1)]
        : command.programArguments,
      environment: supported ? {} : { PATH: "/usr/bin:/bin" },
    }));
    const code = supported ? "runtime" : "gateway-node-version-manager";
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [{ code, message: "runtime migration", level: "recommended" }],
      definitionDrift: supported
        ? undefined
        : [
            {
              kind: "outdated",
              key: "ExitTimeOut",
              current: 20,
              expected: 330,
              message: "old shutdown budget",
            },
          ],
    });
    mocks.resolveSystemNodeInfo.mockResolvedValue(
      supported ? { path: "/usr/bin/node", status: "supported", version: "24.16.0" } : null,
    );
    const prompter = makeDoctorPrompts();
    prompter.confirmRuntimeRepair.mockImplementation(async ({ message }) => {
      const preview = mocks.note.mock.calls.find(
        ([, title]) => title === "Gateway service repair preview",
      )?.[0];
      expect(preview).toContain(`Runtime: ${node} -> ${supported ? "/usr/bin/node" : node}`);
      expect(preview).toContain(
        supported ? "PATH: not set -> not set" : "PATH: /old/bin -> /usr/bin:/bin",
      );
      if (supported) {
        expect(preview).not.toContain("No supported system Node");
      } else {
        for (const text of [
          `Entrypoint: ${entrypoint} -> ${entrypoint}`,
          "Shutdown budget (ExitTimeOut): 20 -> 330",
          "No supported system Node is available",
          "retains a source-checkout entrypoint",
          "`openclaw --profile preview-proof gateway install --force`",
        ]) {
          expect(preview).toContain(text);
        }
        expect(message).not.toContain("recommended defaults");
      }
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("`openclaw --profile preview-proof gateway install --force`"),
        "Gateway service config",
      );
      return approved;
    });
    await withEnvAsync(
      {
        ...(!supported ? { OPENCLAW_GATEWAY_TOKEN: undefined } : {}),
        OPENCLAW_PROFILE: "preview-proof",
        OPENCLAW_CONTAINER_HINT: undefined,
      },
      () =>
        maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter, {
          writeConfig: mocks.writeConfig,
        }),
    );
    expect(prompter.confirmRuntimeRepair).toHaveBeenCalledOnce();
    expect(mocks.install).toHaveBeenCalledTimes(Number(approved));
    if (approved) {
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("Install system Node"),
        "Gateway service findings still unresolved",
      );
      expect(mocks.install).toHaveBeenCalledWith(
        expect.objectContaining({ programArguments: command.programArguments }),
      );
    } else if (!supported) {
      expect(
        mocks.note.mock.calls.some(
          ([, title]) => title === "Gateway service findings still unresolved",
        ),
      ).toBe(false);
    }
  },
);
