import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import {
  planCliEntrypoint,
  resolveGatewayProgramArguments,
  resolveNodeProgramArguments,
} from "./program-args.js";

const originalArgv = process.argv;
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  process.argv = originalArgv;
});

async function convertedInstall() {
  const home = tempDirs.make("openclaw-resident-service-");
  const state = path.join(home, "state");
  const prefix = path.join(state, "git-install");
  const release = path.join(prefix, "releases", "active", "openclaw");
  const npmRoot = path.join(home, "npm", "lib", "node_modules", "openclaw");
  const launcher = path.join(prefix, "openclaw-launcher.mjs");
  await fs.mkdir(path.join(release, "dist"), { recursive: true });
  await fs.writeFile(path.join(release, "dist", "index.js"), "");
  await fs.symlink(release, path.join(prefix, "openclaw"), "junction");
  await fs.writeFile(launcher, "");
  await fs.mkdir(path.join(npmRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(npmRoot, "openclaw.mjs"), "");
  await fs.writeFile(path.join(npmRoot, "dist", "index.js"), "");
  return { home, state, prefix, npmRoot, launcher };
}

it.each(["openclaw.mjs", "dist/index.js"])(
  "keeps the converted Gateway on its resident launcher through an unmarked npm %s",
  async (entry) => {
    const { home, state, npmRoot, launcher } = await convertedInstall();
    const cliEntrypoint = path.join(npmRoot, entry);
    process.argv = [process.execPath, cliEntrypoint];
    const inputs = {
      env: { OPENCLAW_STATE_DIR: state },
      runtime: "node" as const,
      runtimePath: process.execPath,
      port: 18789,
    };
    const service = await resolveGatewayProgramArguments(inputs);
    expect(service.programArguments.slice(-4)).toEqual([launcher, "gateway", "--port", "18789"]);
    expect(service.programArguments[0]).toBe(process.execPath);

    const planned = await planCliEntrypoint({
      sourceEntrypoint: cliEntrypoint,
      sourceRoot: npmRoot,
      packageRoot: path.join(home, "durable", "openclaw"),
      service: "gateway",
    });
    expect(planned.planned).toBe(path.join(home, "durable", "openclaw", "dist", "index.js"));
    const fromPlannedCopy = await resolveGatewayProgramArguments({
      ...inputs,
      cliEntrypoint: planned,
    });
    expect(fromPlannedCopy.programArguments.at(-4)).toBe(launcher);

    for (const runtime of ["node", "bun"] as const) {
      const recovery = await resolveGatewayProgramArguments({
        ...inputs,
        cliEntrypoint,
        runtime,
        runtimePath: "/retained/runtime",
      });
      expect(recovery.programArguments[0]).toBe("/retained/runtime");
      expect(recovery.programArguments.at(-4)).toBe(path.join(npmRoot, "dist", "index.js"));
    }

    const wrapped = await resolveGatewayProgramArguments({
      ...inputs,
      wrapperPath: process.execPath,
      runtimePath: "/custom/node",
    });
    expect(wrapped.programArguments).toEqual([process.execPath, "gateway", "--port", "18789"]);

    // The resident Gateway does not own the separate node service.
    await withEnvAsync({ OPENCLAW_STATE_DIR: state }, async () => {
      const node = await resolveNodeProgramArguments({
        runtime: "node",
        runtimePath: process.execPath,
        host: "gateway.example",
        port: 18789,
      });
      expect(node.programArguments[1]).toBe(path.join(npmRoot, "openclaw.mjs"));
    });

    const otherProfile = await resolveGatewayProgramArguments({
      ...inputs,
      env: { OPENCLAW_STATE_DIR: path.join(home, "other-profile") },
    });
    expect(otherProfile.programArguments.at(-4)).toBe(path.join(npmRoot, "dist", "index.js"));
  },
);

it("requires an existing launcher and a verified release slot", async () => {
  const { state, prefix, npmRoot, launcher } = await convertedInstall();
  const cliEntrypoint = path.join(npmRoot, "dist", "index.js");
  process.argv = [process.execPath, cliEntrypoint];
  const inputs = {
    env: { OPENCLAW_STATE_DIR: state },
    runtime: "node" as const,
    runtimePath: process.execPath,
    port: 18789,
  };
  await fs.unlink(launcher);
  expect((await resolveGatewayProgramArguments(inputs)).programArguments.at(-4)).toBe(
    cliEntrypoint,
  );
  await fs.writeFile(launcher, "");
  await fs.unlink(path.join(prefix, "openclaw"));
  expect((await resolveGatewayProgramArguments(inputs)).programArguments.at(-4)).toBe(
    cliEntrypoint,
  );
});

it("plans a source copy inside a verified release instead of selecting its outside launcher", async () => {
  const { home, prefix } = await convertedInstall();
  const sourceRoot = path.join(prefix, "openclaw");
  const packageRoot = path.join(home, "durable", "openclaw");
  await expect(
    planCliEntrypoint({
      sourceEntrypoint: path.join(sourceRoot, "dist", "index.js"),
      sourceRoot,
      packageRoot,
      service: "gateway",
    }),
  ).resolves.toEqual({ planned: path.join(packageRoot, "dist", "index.js") });
});
