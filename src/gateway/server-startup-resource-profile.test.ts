import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { predictGatewayStartupResourceProfile } from "./server-startup-resource-profile.js";

const memory = vi.hoisted(() => ({ limit: 1.5 * 1024 ** 3 }));
vi.mock("../infra/host-memory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../infra/host-memory.js")>()),
  readEffectiveMemoryLimit: () => ({
    memoryLimitBytes: memory.limit,
    memoryLimitSource: "cgroup-v2" as const,
  }),
}));

const config = (profile: unknown) => ({ gateway: { resources: { profile } } }) as OpenClawConfig;
const snapshotRead = (profile: unknown) =>
  ({ snapshot: { config: config(profile) } }) as unknown as Parameters<
    typeof predictGatewayStartupResourceProfile
  >[0];

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
beforeEach(() => {
  memory.limit = 1.5 * 1024 ** 3;
});

it("uses the CLI startup snapshot without another config read", async () => {
  const read = vi.fn(async () => config("lean"));
  await expect(predictGatewayStartupResourceProfile(snapshotRead("standard"), read)).resolves.toBe(
    "standard",
  );
  memory.limit = 16 * 1024 ** 3;
  await expect(predictGatewayStartupResourceProfile(snapshotRead("lean"), read)).resolves.toBe(
    "lean",
  );
  expect(read).not.toHaveBeenCalled();
});

it("reads the config being started when an in-process restart brings no snapshot", async () => {
  await expect(
    predictGatewayStartupResourceProfile(undefined, async () => config("standard")),
  ).resolves.toBe("standard");
  memory.limit = 16 * 1024 ** 3;
  await expect(
    predictGatewayStartupResourceProfile(undefined, async () => config("lean")),
  ).resolves.toBe("lean");
  await expect(predictGatewayStartupResourceProfile(undefined, async () => ({}))).resolves.toBe(
    "standard",
  );
});

it("falls back to automatic selection for unreadable or invalid settings", async () => {
  await expect(
    predictGatewayStartupResourceProfile(undefined, async () => {
      throw new Error("unreadable config");
    }),
  ).resolves.toBe("lean");
  await expect(
    predictGatewayStartupResourceProfile(undefined, async () => config("throughput")),
  ).resolves.toBe("lean");
  memory.limit = 8 * 1024 ** 3;
  await expect(predictGatewayStartupResourceProfile(snapshotRead(undefined))).resolves.toBe(
    "standard",
  );
});

it("resolves the profile with the dotenv values bootstrap will apply, without changing process env", async () => {
  const directory = tempDirs.make("startup-resource-profile-");
  const configPath = path.join(directory, "openclaw.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ gateway: { resources: { profile: "${OPENCLAW_PREDICTED_PROFILE_PROBE}" } } }),
  );
  fs.writeFileSync(path.join(directory, ".env"), "OPENCLAW_PREDICTED_PROFILE_PROBE=standard\n");
  vi.stubEnv("OPENCLAW_CONFIG_PATH", configPath);
  vi.stubEnv("OPENCLAW_STATE_DIR", directory);
  vi.stubEnv("OPENCLAW_PREDICTED_PROFILE_PROBE", undefined);
  try {
    const before = { ...process.env };
    await expect(predictGatewayStartupResourceProfile(undefined)).resolves.toBe("standard");
    expect(process.env).toEqual(before);
  } finally {
    vi.unstubAllEnvs();
  }
});
