import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  planCliEntrypoint,
  resolveGatewayProgramArguments,
  resolveNodeProgramArguments,
} from "./program-args.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.unstubAllEnvs());

it.each(["openclaw.mjs", "dist/index.js"])(
  "keeps the converted Gateway on its resident launcher through an unmarked npm %s",
  async (entry) => {
    const home = tempDirs.make("openclaw-resident-service-");
    const state = path.join(home, "state");
    const prefix = path.join(state, "git-install");
    const release = path.join(prefix, "releases", "active", "openclaw");
    const npmRoot = path.join(home, "npm", "lib", "node_modules", "openclaw");
    const launcher = path.join(prefix, "openclaw-launcher.mjs");
    await fs.mkdir(release, { recursive: true });
    await fs.symlink(release, path.join(prefix, "openclaw"), "junction");
    await fs.writeFile(launcher, "");
    await fs.mkdir(path.join(npmRoot, "dist"), { recursive: true });
    await fs.writeFile(path.join(npmRoot, "openclaw.mjs"), "");
    await fs.writeFile(path.join(npmRoot, "dist", "index.js"), "");
    vi.stubEnv("OPENCLAW_STATE_DIR", state);
    const cliEntrypoint = path.join(npmRoot, entry);
    const service = await resolveGatewayProgramArguments({
      cliEntrypoint,
      runtime: "node",
      runtimePath: process.execPath,
      port: 18789,
    });
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
      cliEntrypoint: planned,
      runtime: "node",
      runtimePath: process.execPath,
      port: 18789,
    });
    expect(fromPlannedCopy.programArguments.at(-4)).toBe(launcher);

    const wrapped = await resolveGatewayProgramArguments({
      cliEntrypoint,
      wrapperPath: process.execPath,
      runtime: "node",
      runtimePath: "/custom/node",
      port: 18789,
    });
    expect(wrapped.programArguments).toEqual([process.execPath, "gateway", "--port", "18789"]);

    // The resident Gateway does not own the separate node service.
    const node = await resolveNodeProgramArguments({
      cliEntrypoint,
      runtime: "node",
      runtimePath: process.execPath,
      host: "gateway.example",
      port: 18789,
    });
    expect(node.programArguments[1]).toBe(path.join(npmRoot, "openclaw.mjs"));

    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(home, "other-profile"));
    const otherProfile = await resolveGatewayProgramArguments({
      cliEntrypoint,
      runtime: "node",
      runtimePath: process.execPath,
      port: 18789,
    });
    expect(otherProfile.programArguments.at(-4)).toBe(path.join(npmRoot, "dist", "index.js"));
    vi.stubEnv("OPENCLAW_STATE_DIR", state);

    // A leftover launcher without a verified release slot does not convert an install.
    await fs.unlink(path.join(prefix, "openclaw"));
    const unconverted = await resolveGatewayProgramArguments({
      cliEntrypoint,
      runtime: "node",
      runtimePath: process.execPath,
      port: 18789,
    });
    expect(unconverted.programArguments.at(-4)).toBe(path.join(npmRoot, "dist", "index.js"));
  },
);
