import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { getCliProcessTestTimeout } from "../cli/cli-process-child.test-helpers.js";
import { readConfigFileSnapshot } from "../config/io.runtime.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runInitialConfigWriteHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { getFreePort } from "../test-utils/ports.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import {
  createBuiltRuntime,
  runBuiltRuntime,
} from "./doctor-config-preflight.process.test-support.js";
import { useDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const CLI_TIMEOUT = 60_000;
const runtimeDirs = useAutoCleanupTempDirTracker(afterAll);
const withDoctorConfigPreflightHome = useDoctorConfigPreflightHome();
const read = (file: string | URL) => fs.readFile(file, "utf8");
const writeCoreConfig = (home: string, config: Record<string, unknown>) =>
  writeOpenClawConfig(home, { gateway: { mode: "local" }, plugins: { enabled: false }, ...config });
const withCoreHome = (run: (home: string) => Promise<void>) =>
  withDoctorConfigPreflightHome((home) =>
    withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, () => run(home)),
  );
const search = (enabled: boolean, maxResults: number, extra: Record<string, unknown> = {}) => ({
  enabled,
  query: { maxResults },
  ...extra,
});
const bypass = (allowCrossContextSend: boolean, crossContext?: Record<string, unknown>) => ({
  tools: { message: { allowCrossContextSend, ...(crossContext ? { crossContext } : {}) } },
});
const roster = (entries: Record<string, unknown>) => ({ ownership: "explicit", entries });
const memoryEnv = (prefix = "") => ({
  DOCTOR_MEMORY_KEY: `${prefix}memory-secret-canary`,
  DOCTOR_MEMORY_PROVIDER: "auto",
  DOCTOR_CANONICAL_MEMORY_KEY: `${prefix}canonical-secret-canary`,
});

async function repairConfig(configPath: string) {
  await using ctx = await prepareDoctorContext(configPath);
  await runInitialConfigWriteHealth(ctx);
  return {
    shouldWriteConfig: ctx.configResult.shouldWriteConfig,
    configWriteRefusal: ctx.configWriteRefusal,
  };
}

afterEach(() => closeOpenClawStateDatabaseForTest());

it("preserves the July TTS preference locator before retiring its config keys", () =>
  withCoreHome(async (home) => {
    const prefsPath = path.join(home, "speech-preferences.json");
    const preferences = '{"tts":{"auto":"off","maxLength":1200}}\n';
    await fs.writeFile(prefsPath, preferences);
    const configPath = await writeCoreConfig(home, {
      agents: { list: [{ id: "main" }] },
      messages: { tts: { prefsPath, personas: { narrator: { prompt: { style: "calm" } } } } },
    });
    await repairConfig(configPath);
    expect((await readConfigFileSnapshot()).valid).toBe(true);
    expect(readConfigMachineState("tts.prefsPath")).toBe(prefsPath);
    expect(await read(prefsPath)).toBe(preferences);
    const first = await read(configPath);
    expect(JSON.parse(first)).not.toHaveProperty("messages.tts");
    expect(JSON.parse(first)).not.toHaveProperty("tts.prefsPath");
    expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
    expect(await read(configPath)).toBe(first);
  }));

it(
  "converges the July upgrade fixture with an explicit local model",
  () =>
    withDoctorConfigPreflightHome(async (home) => {
      const raw = JSON.parse(
        await read(new URL("../../test/fixtures/doctor-2026.7.1.json", import.meta.url)),
      );
      raw.agents.defaults.memorySearch.local = { modelPath: "/synthetic/embedding.gguf" };
      raw.gateway.port = await getFreePort();
      const configPath = await writeOpenClawConfig(home, raw);
      const cliRuntime = createBuiltRuntime(runtimeDirs.make("openclaw-doctor-legacy-runtime-"));
      await fs.unlink(path.join(cliRuntime, "src"));
      const env: NodeJS.ProcessEnv = {
        ...Object.fromEntries(
          ["PATH", "SystemRoot", "WINDIR", "ComSpec"].map((key) => [key, process.env[key]]),
        ),
        HOME: home,
        USERPROFILE: home,
        TMPDIR: home,
        OPENCLAW_STATE_DIR: path.dirname(configPath),
        OPENCLAW_CONFIG_PATH: configPath,
        NODE_COMPILE_CACHE: path.join(cliRuntime, "node-compile-cache"),
        NO_COLOR: "1",
      };
      const run = async (args: string[], expected = 0) => {
        const result = await runBuiltRuntime(cliRuntime, env, args, CLI_TIMEOUT);
        expect(result.code, `${result.stdout}\n${result.stderr}`).toBe(expected);
      };
      const doctorArgs = ["doctor", "--fix", "--non-interactive", "--no-workspace-suggestions"];
      await run(["config", "validate"], 1);
      await run(doctorArgs);
      const first = await read(configPath);
      const saved = JSON.parse(first);
      await run(["config", "validate"]);
      expect(saved.agents).not.toHaveProperty("list");
      expect(saved.agents.ownership).toBe("explicit");
      expect(Object.keys(saved.agents.entries)).toEqual(["main", "research"]);
      expect(saved.agents.defaults.systemAgent.agentId).toBe("main");
      expect(saved.meta.migrations.modelPolicyAllowlist).toBe(true);
      const allowedModels = ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-7"];
      expect(saved.agents.defaults.modelPolicy.allow).toEqual(allowedModels);
      expect(saved.memory.search).toEqual({ ...raw.agents.defaults.memorySearch });
      expect(saved.tools.media.models).toEqual([
        { ...raw.tools.media.audio.models[0], capabilities: ["audio"] },
      ]);
      expect(saved.gateway.nodes.commands.deny).toEqual(["system.run"]);
      expect(saved.channels.telegram.groupAllowFrom).toEqual(["123456789"]);
      expect(saved.channels.telegram.accounts.secondary.groupAllowFrom).toEqual(["987654321"]);
      expect(saved.plugins.entries.browser.enabled).toBe(true);
      expect(saved.meta).not.toHaveProperty("lastTouchedAt");
      expect(saved.gateway.tailscale).not.toHaveProperty("resetOnExit");
      await run(doctorArgs);
      expect(await read(configPath)).toBe(first);
    }),
  getCliProcessTestTimeout(CLI_TIMEOUT, CLI_TIMEOUT, CLI_TIMEOUT, CLI_TIMEOUT),
);

it.each(["duplicate ids", "whole-entry include"])(
  "refuses ambiguous legacy roster persistence for %s",
  (shape) =>
    withCoreHome(async (home) => {
      const duplicate = shape === "duplicate ids";
      const identity = { name: "Second agent" };
      const included = { $include: "included.json" };
      const includedConfig = duplicate ? identity : { identity, memorySearch: { enabled: false } };
      const includeRaw = `${JSON.stringify(includedConfig, null, 3)}\n`;
      const configPath = await writeCoreConfig(home, {
        agents: {
          list: duplicate
            ? [
                { id: "worker", name: "First agent" },
                { id: "worker", name: "Second agent", identity: included },
              ]
            : [{ id: "worker", ...included }],
          ...(duplicate ? { defaults: { memorySearch: { enabled: false } } } : {}),
        },
      });
      const includePath = path.join(path.dirname(configPath), "included.json");
      await fs.writeFile(includePath, includeRaw);
      const rootRaw = await read(configPath);
      expect((await readConfigFileSnapshot()).valid).toBe(false);
      const refusal = await repairConfig(configPath).then(
        (result) => result.configWriteRefusal,
        (error: unknown) => {
          expect(error).toMatchObject({ message: expect.stringContaining("$include-owned") });
          return "include-ownership";
        },
      );
      expect(["validation", "include-ownership"]).toContain(refusal);
      expect(await read(configPath)).toBe(rootRaw);
      expect(await read(includePath)).toBe(includeRaw);
      expect((await readConfigFileSnapshot()).valid).toBe(false);
    }),
);

it.each([
  ["$${DOCTOR_MEMORY_KEY}", "auto", undefined],
  ["${DOCTOR_MEMORY_KEY}", "${DOCTOR_MEMORY_PROVIDER}", undefined],
  ["${DOCTOR_MEMORY_KEY}", "auto", "${DOCTOR_CANONICAL_MEMORY_KEY}"],
] satisfies Array<[string, string, string | undefined]>)(
  "preserves migrated %s references while canonicalizing %s with canonical key %s",
  (apiKey, provider, canonicalApiKey) =>
    withCoreHome(async (home) => {
      await withEnvAsync(memoryEnv(), async () => {
        const expectedKey = apiKey.startsWith("$$")
          ? "${DOCTOR_MEMORY_KEY}"
          : `${canonicalApiKey ? "canonical" : "memory"}-secret-canary`;
        const rotatedKey = apiKey.startsWith("$$") ? expectedKey : `rotated-${expectedKey}`;
        const remote = canonicalApiKey ? { remote: { apiKey: canonicalApiKey } } : {};
        const configPath = await writeCoreConfig(home, {
          memory: { search: search(false, 9, remote) },
          agents: {
            defaults: {
              memorySearch: search(true, 7, { provider, remote: { apiKey } }),
            },
            entries: {
              ops: {
                memorySearch: { ...search(true, 3), provider: "auto" },
                memory: { search: search(false, 5) },
              },
            },
          },
        });
        await using ctx = await prepareDoctorContext(configPath);
        await withEnvAsync(memoryEnv("rotated-"), async () => {
          await runInitialConfigWriteHealth(ctx);
          const snapshot = await readConfigFileSnapshot();
          expect(snapshot.valid).toBe(true);
          expect(snapshot.sourceConfig.memory?.search?.remote?.apiKey).toBe(rotatedKey);
        });
        expect(ctx.configWriteRefusal).toBeUndefined();
        expect(ctx.configResult.cfg.memory?.search?.remote?.apiKey).toBe(expectedKey);
        const saved = JSON.parse(await read(configPath));
        expect(saved.memory.search).toEqual(
          search(false, 9, { provider: "openai", remote: { apiKey: canonicalApiKey ?? apiKey } }),
        );
        expect(saved.agents.defaults).not.toHaveProperty("memorySearch");
        const ops = saved.agents.entries.ops;
        expect(ops.memory.search).toEqual(search(false, 5, { provider: "openai" }));
        expect(ops).not.toHaveProperty("memorySearch");
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
      });
    }),
);

it.each([undefined, true, false])(
  "preserves message bypass inheritance and precedence with explicit root denial %s",
  (rootBypass) =>
    withCoreHome(async (home) => {
      const globalBypass = rootBypass ?? true;
      const denied = { allowWithinProvider: false, allowAcrossProviders: false };
      const configPath = await writeCoreConfig(home, {
        ...bypass(globalBypass, rootBypass === undefined ? undefined : denied),
        agents: roster({
          restricted: bypass(false),
          ...(rootBypass === undefined
            ? { inherited: {} }
            : {
                allowed: bypass(true, { ...denied, marker: { enabled: false } }),
                inherited: { tools: { message: { crossContext: denied } } },
              }),
        }),
      });
      await repairConfig(configPath);
      const snapshot = await readConfigFileSnapshot();
      expect(snapshot.valid).toBe(true);
      if (rootBypass === undefined) {
        const saved = JSON.parse(await read(configPath));
        expect(saved.agents.entries.restricted.tools.message).toEqual({
          crossContext: { allowWithinProvider: true, allowAcrossProviders: false },
        });
        expect(saved.tools.message).toEqual({
          crossContext: { allowWithinProvider: true, allowAcrossProviders: true },
        });
      } else {
        const { resolveEffectiveMessageToolsConfig } =
          await import("../infra/outbound/outbound-policy.js");
        const effective = (agentId: string) =>
          resolveEffectiveMessageToolsConfig({ cfg: snapshot.config, agentId });
        expect(effective("restricted")?.crossContext).toMatchObject(denied);
        expect(effective("allowed")?.crossContext).toEqual({
          allowWithinProvider: true,
          allowAcrossProviders: true,
          marker: { enabled: false },
        });
        expect(effective("inherited")?.crossContext).toEqual({
          allowWithinProvider: globalBypass,
          allowAcrossProviders: globalBypass,
        });
        expect(await read(configPath)).not.toContain("allowCrossContextSend");
      }
      expect((await repairConfig(configPath)).shouldWriteConfig).toBe(false);
    }),
);
