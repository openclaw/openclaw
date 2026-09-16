import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { resolveWorkspaceDotEnvPath } from "../infra/dotenv-paths.js";
import { canUsePrecomputedRootHelpWithoutLiveConfig } from "./root-help-preflight.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    cleanup();
  }),
);

function createFixture(raw: string): {
  configPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  home: string;
} {
  const home = tempDirs.make("openclaw-root-help-preflight-");
  const cwd = path.join(home, "cwd");
  const configPath = path.join(home, "profile", "openclaw.json");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, raw, "utf8");
  return {
    configPath,
    cwd,
    env: { HOME: home, OPENCLAW_CONFIG_PATH: configPath },
    home,
  };
}

describe("root help config preflight", () => {
  it.each([
    '{"plugins":{}}',
    '{"gateway":{"port":1234},"plugins":{"enabled":true}}',
    '{"plugins":{"allow":[],"deny":[],"load":{"paths":[]},"slots":{},"entries":{}}}',
  ])("accepts a static strict-JSON plugin config: %s", (raw) => {
    const fixture = createFixture(raw);
    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(fixture.env, {
        cwd: fixture.cwd,
        homedir: () => fixture.home,
      }),
    ).toBe(true);
  });

  it.each([
    { name: "default", dir: ".openclaw", file: "openclaw.json", env: {} },
    { name: "legacy", dir: ".clawdbot", file: "clawdbot.json", env: {} },
    {
      name: "named profile state",
      dir: ".openclaw-work",
      file: "openclaw.json",
      env: { OPENCLAW_PROFILE: "work" },
    },
  ])("reuses $name config selection", ({ dir, env, file }) => {
    const home = tempDirs.make("openclaw-root-help-selection-");
    const cwd = path.join(home, "cwd");
    const configPath = path.join(home, dir, file);
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, '{"plugins":{}}', "utf8");

    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(
        {
          HOME: home,
          ...env,
          ...(env.OPENCLAW_PROFILE ? { OPENCLAW_STATE_DIR: path.join(home, dir) } : {}),
        },
        { cwd, homedir: () => home },
      ),
    ).toBe(true);
  });

  it.each([
    ['{"plugins":{"enabled":false}}', "disabled plugins"],
    ['{"plugins":{"allow":["memory-core"]}}', "allowlist"],
    ['{"plugins":{"deny":["memory-core"]}}', "denylist"],
    ['{"plugins":{"load":{"paths":["./plugin"]}}}', "load paths"],
    ['{"plugins":{"slots":{"memory":"memory-core"}}}', "slots"],
    ['{"plugins":{"entries":{"memory-core":{"enabled":true}}}}', "entries"],
  ])("rejects help-affecting %s", (raw) => {
    const fixture = createFixture(raw);
    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(fixture.env, {
        cwd: fixture.cwd,
        homedir: () => fixture.home,
      }),
    ).toBe(false);
  });

  it.each([
    ["{plugins:{}}", "JSON5"],
    ['{"plugins":{},"$include":"fragment.json"}', "include"],
    ['{"plugins":{},"label":"${PROFILE}"}', "environment substitution"],
    ['{"plugins":{},"env":{}}', "config-owned environment"],
    ['{"plugins":{"futureField":true}}', "unknown plugin field"],
    ['{"plugins":[]}', "invalid plugin shape"],
  ])("falls back for %s", (raw) => {
    const fixture = createFixture(raw);
    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(fixture.env, {
        cwd: fixture.cwd,
        homedir: () => fixture.home,
      }),
    ).toBe(false);
  });

  it("falls back instead of throwing when raw config traversal exceeds the stack", () => {
    const depth = 5_000;
    const nested = `${'{"value":'.repeat(depth)}"safe"${"}".repeat(depth)}`;
    const fixture = createFixture(`{"plugins":{},"nested":${nested}}`);

    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(fixture.env, {
        cwd: fixture.cwd,
        homedir: () => fixture.home,
      }),
    ).toBe(false);
  });

  it("falls back when any canonical dotenv path exists", () => {
    const workspace = createFixture('{"plugins":{}}');
    fs.writeFileSync(path.join(workspace.cwd, ".env"), "SAFE=value\n", "utf8");
    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(workspace.env, {
        cwd: workspace.cwd,
        homedir: () => workspace.home,
      }),
    ).toBe(false);

    const state = createFixture('{"plugins":{}}');
    fs.writeFileSync(path.join(path.dirname(state.configPath), ".env"), "SAFE=value\n", "utf8");
    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(state.env, {
        cwd: state.cwd,
        homedir: () => state.home,
      }),
    ).toBe(false);

    const legacy = createFixture('{"plugins":{}}');
    const legacyEnvPath = path.join(legacy.home, ".config", "openclaw", "gateway.env");
    fs.mkdirSync(path.dirname(legacyEnvPath), { recursive: true });
    fs.writeFileSync(legacyEnvPath, "SAFE=value\n", "utf8");
    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(legacy.env, {
        cwd: legacy.cwd,
        homedir: () => legacy.home,
      }),
    ).toBe(false);
  });

  it("checks the ambient cwd dotenv when no cwd override is provided", () => {
    const fixture = createFixture('{"plugins":{}}');
    fs.writeFileSync(path.join(fixture.cwd, ".env"), "SAFE=value\n", "utf8");
    vi.spyOn(process, "cwd").mockReturnValue(fixture.cwd);

    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(fixture.env, {
        homedir: () => fixture.home,
      }),
    ).toBe(false);
  });

  it("preserves an explicit no-cwd selection for async config preparation", () => {
    vi.spyOn(process, "cwd").mockReturnValue("/ambient/workspace");
    expect(resolveWorkspaceDotEnvPath({ cwd: undefined })).toBeNull();
  });

  it("falls back for plugin-sensitive process environment", () => {
    const fixture = createFixture('{"plugins":{}}');
    expect(
      canUsePrecomputedRootHelpWithoutLiveConfig(
        { ...fixture.env, OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        { cwd: fixture.cwd, homedir: () => fixture.home },
      ),
    ).toBe(false);
  });
});
