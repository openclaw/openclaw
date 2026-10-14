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
  mocks.resolveSystemNodeInfo.mockResolvedValue(null);
});

it.each([false, true])(
  "previews unresolved runtime and source findings before consent (approved=%s)",
  async (approved) => {
    const root = tempDirs.make("openclaw-doctor-preview-");
    for (const directory of [".git", "src", "extensions", "dist"]) {
      await fs.mkdir(path.join(root, directory));
    }
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
    const entrypoint = path.join(root, "dist", "index.js");
    await fs.writeFile(entrypoint, "export {};\n");
    const node = "/home/test/.nvm/versions/node/v24.16.0/bin/node";
    const command = {
      programArguments: [node, entrypoint, "gateway", "--port", "18789"],
      environment: { PATH: "/old/bin" },
    };
    const plan = { ...command, environment: { PATH: "/usr/bin:/bin" } };
    mocks.readCommand.mockResolvedValue(command);
    mocks.buildGatewayInstallPlan.mockResolvedValue(plan);
    mocks.auditGatewayServiceConfig.mockResolvedValue({
      ok: false,
      issues: [
        {
          code: "gateway-node-version-manager",
          message: "version-managed Node",
          level: "recommended",
        },
      ],
      definitionDrift: [
        {
          kind: "outdated",
          key: "ExitTimeOut",
          current: 20,
          expected: 330,
          message: "old shutdown budget",
        },
      ],
    });
    const prompter = makeDoctorPrompts();
    prompter.confirmRuntimeRepair.mockImplementation(async ({ message }) => {
      const preview = mocks.note.mock.calls.find(
        ([, title]) => title === "Gateway service repair preview",
      )?.[0];
      expect(preview).toContain(`Runtime: ${node} -> ${node}`);
      expect(preview).toContain(`Entrypoint: ${entrypoint} -> ${entrypoint}`);
      expect(preview).toContain("PATH: /old/bin -> /usr/bin:/bin");
      expect(preview).toContain("Shutdown budget (ExitTimeOut): 20 -> 330");
      expect(preview).toContain("No supported system Node is available");
      expect(preview).toContain("retains a source-checkout entrypoint");
      expect(preview).toContain("`openclaw --profile preview-proof gateway install --force`");
      expect(mocks.note).toHaveBeenCalledWith(
        expect.stringContaining("`openclaw --profile preview-proof gateway install --force`"),
        "Gateway service config",
      );
      expect(message).not.toContain("recommended defaults");
      return approved;
    });
    await withEnvAsync(
      {
        OPENCLAW_GATEWAY_TOKEN: undefined,
        OPENCLAW_PROFILE: "preview-proof",
        OPENCLAW_CONTAINER_HINT: undefined,
      },
      async () => {
        await maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter, {
          writeConfig: mocks.writeConfig,
        });
      },
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
    } else {
      expect(
        mocks.note.mock.calls.some(
          ([, title]) => title === "Gateway service findings still unresolved",
        ),
      ).toBe(false);
    }
  },
);

it("previews a supported system runtime instead of claiming the runtime warning will remain", async () => {
  const command = {
    programArguments: ["/home/test/.nvm/bin/node", "/synthetic/openclaw/dist/index.js", "gateway"],
    environment: {},
  };
  mocks.readCommand.mockResolvedValue(command);
  mocks.buildGatewayInstallPlan.mockImplementation(async ({ runtimePath }) => ({
    ...command,
    programArguments: [
      runtimePath ?? command.programArguments[0],
      ...command.programArguments.slice(1),
    ],
  }));
  mocks.auditGatewayServiceConfig.mockResolvedValue({
    ok: false,
    issues: [{ code: "runtime", message: "runtime migration", level: "recommended" }],
  });
  mocks.resolveSystemNodeInfo.mockResolvedValue({
    path: "/usr/bin/node",
    status: "supported",
    version: "24.16.0",
  });
  const prompter = makeDoctorPrompts();
  prompter.confirmRuntimeRepair.mockResolvedValue(false);
  await withEnvAsync(
    { OPENCLAW_PROFILE: "preview-proof", OPENCLAW_CONTAINER_HINT: undefined },
    async () => {
      await maybeRepairGatewayServiceConfig({ gateway: {} }, "local", makeDoctorIo(), prompter, {
        writeConfig: mocks.writeConfig,
      });
    },
  );
  expect(mocks.note).toHaveBeenCalledWith(
    expect.stringContaining("`openclaw --profile preview-proof gateway install --force`"),
    "Gateway service config",
  );
  const preview = mocks.note.mock.calls.find(
    ([, title]) => title === "Gateway service repair preview",
  )?.[0];
  expect(preview).toContain("Runtime: /home/test/.nvm/bin/node -> /usr/bin/node");
  expect(preview).toContain("PATH: not set -> not set");
  expect(preview).not.toContain("No supported system Node");
  expect(mocks.install).not.toHaveBeenCalled();
});
