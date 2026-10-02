import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { readConfigFileSnapshot, transformConfigFile } from "../config/config.js";
import { hashConfigRaw } from "../config/io.read-helpers.js";
import { writeOpenClawConfig } from "../config/test-helpers.js";
import { runWriteConfigHealth } from "../flows/doctor-health-contribution-runners.config.js";
import { captureUpdateDoctorConfigWrites } from "../infra/update-doctor-result.js";
import { UpdateRequesterRevokedError } from "../infra/update-requester-authority.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { prepareDoctorContext } from "./doctor-config-flow.test-support.js";
import { withDoctorConfigPreflightHome } from "./doctor-config-preflight.test-support.js";

const noteMock = vi.hoisted(() => vi.fn<(message: string, title?: string) => void>());

vi.mock("../../packages/terminal-core/src/note.js", () => ({ note: noteMock }));

describe("doctor config persistence", () => {
  afterEach(() => {
    noteMock.mockClear();
    closeOpenClawStateDatabaseForTest();
  });

  it.each([
    {
      name: "Telegram",
      channels: {
        telegram: {
          groupMentionsOnly: false,
          dm: {},
          direct: { "42": { threadReplies: "always" } },
          accounts: {
            native: {
              streaming: {
                preview: { nativeToolProgress: true, nativeToolProgressAllowFrom: ["42"] },
              },
            },
            flat: {
              streamMode: "partial",
              chunkMode: "newline",
              blockStreaming: true,
              blockStreamingCoalesce: {},
              draftChunk: {},
            },
            scalar: { streaming: "block" },
            disabled: { streaming: false },
          },
        },
      },
      fields: [
        "channels.telegram.groupMentionsOnly",
        "channels.telegram.dm",
        "channels.telegram.direct.42.threadReplies",
        "channels.telegram.accounts.native.streaming.preview.nativeToolProgress",
        "channels.telegram.accounts.native.streaming.preview.nativeToolProgressAllowFrom",
        "channels.telegram.accounts.flat.streamMode",
        "channels.telegram.accounts.flat.chunkMode",
        "channels.telegram.accounts.flat.blockStreaming",
        "channels.telegram.accounts.flat.blockStreamingCoalesce",
        "channels.telegram.accounts.flat.draftChunk",
        "channels.telegram.accounts.scalar.streaming",
        "channels.telegram.accounts.disabled.streaming",
      ],
    },
    {
      name: "Matrix",
      channels: {
        matrix: {
          allowPrivateNetwork: false,
          dm: { policy: "trusted", allowFrom: ["@alice:example.org"] },
          groups: { "!group:example.org": { allow: false } },
          rooms: { "!room:example.org": { allow: true } },
          accounts: {
            ops: {
              allowPrivateNetwork: true,
              dm: { policy: "trusted", allowFrom: [] },
              groups: { "!account-group:example.org": { allow: true } },
              rooms: { "!account-room:example.org": { allow: false } },
            },
          },
        },
      },
      fields: [
        "channels.matrix.allowPrivateNetwork",
        "channels.matrix.dm.policy",
        "channels.matrix.groups.!group:example.org.allow",
        "channels.matrix.rooms.!room:example.org.allow",
        "channels.matrix.accounts.ops.allowPrivateNetwork",
        "channels.matrix.accounts.ops.dm.policy",
        "channels.matrix.accounts.ops.groups.!account-group:example.org.allow",
        "channels.matrix.accounts.ops.rooms.!account-room:example.org.allow",
      ],
    },
    {
      name: "Slack",
      channels: {
        slack: {
          channels: { C_ROOT: { allow: false } },
          accounts: { ops: { channels: { C_ACCOUNT: { allow: true } } } },
        },
      },
      fields: [
        "channels.slack.channels.C_ROOT.allow",
        "channels.slack.accounts.ops.channels.C_ACCOUNT.allow",
      ],
    },
  ])(
    "refuses retired $name inputs before include repair or backup recovery",
    async ({ channels, fields }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        const configPath = await writeOpenClawConfig(home, {
          channels: { $include: "./channels.json" },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const includePath = path.join(path.dirname(configPath), "channels.json");
        const includedBytes = JSON.stringify(channels);
        await fs.writeFile(includePath, includedBytes);
        const rootBytes = await fs.readFile(configPath, "utf8");
        const backupBytes = '{"gateway":{"mode":"local"}}\n';
        await fs.writeFile(`${configPath}.bak`, backupBytes);
        const failure = await prepareDoctorContext(configPath).then(
          () => null,
          (error: unknown) => error,
        );
        expect(failure).toBeInstanceOf(Error);
        expect(failure).toHaveProperty(
          "message",
          expect.stringContaining("Install OpenClaw 2026.9.5"),
        );
        for (const field of fields) {
          expect(failure).toHaveProperty("message", expect.stringContaining(field));
        }
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootBytes);
        await expect(fs.readFile(includePath, "utf8")).resolves.toBe(includedBytes);
        await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(backupBytes);
      });
    },
  );

  it.each([
    {
      name: "Telegram streaming",
      channels: { telegram: { streaming: { mode: "off" }, direct: { "42": {} } } },
    },
    {
      name: "Matrix and Slack policy",
      channels: {
        matrix: {
          network: { dangerouslyAllowPrivateNetwork: false },
          dm: { policy: "allowlist", allowFrom: ["@alice:example.org"] },
          groups: { "!group:example.org": { enabled: false } },
          rooms: { "!room:example.org": { enabled: true } },
          accounts: {
            ops: {
              network: { dangerouslyAllowPrivateNetwork: true },
              dm: { policy: "pairing" },
              groups: { "!account-group:example.org": { enabled: true } },
              rooms: { "!account-room:example.org": { enabled: false } },
            },
          },
        },
        slack: {
          channels: { C_ROOT: { enabled: false } },
          accounts: { ops: { channels: { C_ACCOUNT: { enabled: true } } } },
        },
      },
    },
  ])("keeps canonical $name settings eligible for Doctor", async ({ channels }) => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        channels,
        gateway: { mode: "local" },
        plugins: { enabled: false },
      });
      const ctx = await prepareDoctorContext(configPath);
      expect(ctx.cfg.channels).toMatchObject(channels);
    });
  });

  it("refuses retired Discord inputs before include repair or backup recovery", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      const configPath = await writeOpenClawConfig(home, {
        channels: { $include: "./channels.json" },
        gateway: { mode: "local" },
        plugins: { enabled: false },
      });
      const includePath = path.join(path.dirname(configPath), "channels.json");
      const entry = {
        voice: {
          tts: {
            openai: { voice: "alloy" },
            elevenlabs: { voiceId: "fixture-voice" },
            microsoft: { voice: "en-US-AriaNeural" },
            edge: { voice: "en-US-GuyNeural" },
          },
        },
        guilds: { "100": { channels: { "200": { allow: false, agentId: "main" } } } },
      };
      const includedBytes = JSON.stringify({
        discord: { ...entry, accounts: { work: entry } },
      });
      await fs.writeFile(includePath, includedBytes);
      const rootBytes = await fs.readFile(configPath, "utf8");
      const backupBytes = '{"gateway":{"mode":"local"}}\n';
      await fs.writeFile(`${configPath}.bak`, backupBytes);

      const failure = await prepareDoctorContext(configPath).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(Error);
      expect(failure).toHaveProperty(
        "message",
        expect.stringContaining("Install OpenClaw 2026.9.7"),
      );
      for (const prefix of ["channels.discord", "channels.discord.accounts.work"]) {
        for (const field of [
          "voice.tts.openai",
          "voice.tts.elevenlabs",
          "voice.tts.microsoft",
          "voice.tts.edge",
          "guilds.100.channels.200.allow",
          "guilds.100.channels.200.agentId",
        ]) {
          expect(failure).toHaveProperty("message", expect.stringContaining(`${prefix}.${field}`));
        }
      }
      await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootBytes);
      await expect(fs.readFile(includePath, "utf8")).resolves.toBe(includedBytes);
      await expect(fs.readFile(`${configPath}.bak`, "utf8")).resolves.toBe(backupBytes);
    });
  });

  it("preserves browser references across authorized successive writes and environment rotation", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync(
        { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1", BROWSER_BIN: "/opt/example/browser-planning" },
        async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: { entries: { main: {} } },
            browser: { $include: "./browser.json" },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const includePath = path.join(path.dirname(configPath), "browser.json");
          const includeRaw = JSON.stringify({
            enabled: true,
            color: "#FF4500",
            executablePath: "${BROWSER_BIN}",
          });
          await fs.writeFile(includePath, includeRaw);
          const rootRaw = await fs.readFile(configPath, "utf8");
          const ctx = await prepareDoctorContext(configPath);
          expect(ctx.configResult.shouldWriteConfig).toBe(true);
          expect(ctx.configResult.skipWizardMetadataForIncludeWrite).toBe(true);
          expect(ctx.cfg.browser).toEqual({
            enabled: true,
            executablePath: "/opt/example/browser-planning",
          });
          const write = () =>
            captureUpdateDoctorConfigWrites(
              configPath,
              () => runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
              { inputHash: hashConfigRaw(rootRaw), assertCurrent: () => {} },
            );
          await withEnvAsync({ BROWSER_BIN: "/opt/example/browser-first" }, async () => {
            expect(await write()).toBe(true);
            expect(JSON.parse(await fs.readFile(includePath, "utf8"))).toEqual({
              enabled: true,
              executablePath: "${BROWSER_BIN}",
            });
            expect((await readConfigFileSnapshot()).sourceConfig.browser?.executablePath).toBe(
              "/opt/example/browser-first",
            );
          });
          const firstBytes = await fs.readFile(includePath, "utf8");
          await expect(fs.readFile(`${includePath}.bak`, "utf8")).resolves.toBe(includeRaw);
          ctx.cfg = { ...ctx.cfg, browser: { ...ctx.cfg.browser, enabled: false } };
          await withEnvAsync({ BROWSER_BIN: "/opt/example/browser-second" }, async () => {
            expect(await write()).toBe(true);
            const snapshot = await readConfigFileSnapshot();
            expect(snapshot.sourceConfig.browser).toEqual({
              enabled: false,
              executablePath: "/opt/example/browser-second",
            });
            expect(ctx.configResult.confirmedConfigSource?.hash).toBe(snapshot.hash);
          });
          expect(JSON.parse(await fs.readFile(includePath, "utf8")).executablePath).toBe(
            "${BROWSER_BIN}",
          );
          await expect(fs.readFile(`${includePath}.bak`, "utf8")).resolves.toBe(firstBytes);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
          const secondBytes = await fs.readFile(includePath, "utf8");
          expect(await write()).toBe(true);
          await expect(fs.readFile(includePath, "utf8")).resolves.toBe(secondBytes);
          await expect(fs.readFile(`${includePath}.bak`, "utf8")).resolves.toBe(firstBytes);
          const committed = structuredClone({
            receipt: ctx.configResult.confirmedConfigSource,
            baseline: ctx.cfgForPersistence,
          });
          await fs.appendFile(includePath, "\n");
          const files = (await fs.readdir(path.dirname(configPath))).toSorted();
          const retainedBytes = await fs.readFile(includePath, "utf8");
          ctx.cfg = { ...ctx.cfg, browser: { ...ctx.cfg.browser, headless: true } };
          expect(await write()).toBe(false);
          expect(ctx.configWriteRefusal).toBe("config-conflict");
          expect(ctx.configResult.confirmedConfigSource).toStrictEqual(committed.receipt);
          expect(ctx.cfgForPersistence).toStrictEqual(committed.baseline);
          await expect(fs.readFile(includePath, "utf8")).resolves.toBe(retainedBytes);
          await expect(fs.readFile(`${includePath}.bak`, "utf8")).resolves.toBe(firstBytes);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
          expect((await fs.readdir(path.dirname(configPath))).toSorted()).toEqual(files);
        },
      );
    });
  });

  it.each([
    { shape: "nested-defaults", authority: false },
    { shape: "included-roster", authority: true },
  ] as const)(
    "migrates a published $shape config without flattening includes (authority=$authority)",
    async ({ shape, authority }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: { $include: "./agents.json5" },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const dir = path.dirname(configPath);
          const defaults = { models: { "openai/gpt-5.5": { alias: "Config Lab" } } };
          const agents =
            shape === "nested-defaults"
              ? { defaults: { $include: "./defaults.json5" }, entries: { ops: {} } }
              : {
                  defaults,
                  list: [
                    {
                      id: "ops",
                      default: true,
                      memorySearch: { enabled: false, query: { maxResults: 7 } },
                    },
                  ],
                };
          const agentsPath = path.join(dir, "agents.json5");
          const agentsRaw = JSON.stringify(agents);
          await fs.writeFile(agentsPath, agentsRaw);
          const defaultsPath = path.join(dir, "defaults.json5");
          if (shape === "nested-defaults") {
            await fs.writeFile(defaultsPath, JSON.stringify(defaults));
          }
          const rootRaw = await fs.readFile(configPath, "utf8");
          const ctx = await prepareDoctorContext(configPath);
          await captureUpdateDoctorConfigWrites(
            configPath,
            () => runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
            authority ? { inputHash: hashConfigRaw(rootRaw), assertCurrent: () => {} } : undefined,
          );

          expect(ctx.configWriteRefusal).toBeUndefined();
          expect(ctx.configResultWriteCommitted).toBe(true);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
          const savedAgents = JSON.parse(await fs.readFile(agentsPath, "utf8"));
          const savedDefaults =
            shape === "nested-defaults"
              ? JSON.parse(await fs.readFile(defaultsPath, "utf8"))
              : savedAgents.defaults;
          expect(savedDefaults.models).toEqual(defaults.models);
          expect(savedDefaults.modelPolicy).toEqual({ allow: ["openai/gpt-5.5"] });
          if (shape === "nested-defaults") {
            await expect(fs.readFile(agentsPath, "utf8")).resolves.toBe(agentsRaw);
          } else {
            expect(savedAgents).not.toHaveProperty("list");
            expect(savedAgents.entries.ops.memory).toEqual({
              search: { enabled: false, query: { maxResults: 7 } },
            });
          }
          expect((await prepareDoctorContext(configPath)).configResult.shouldWriteConfig).toBe(
            false,
          );

          await transformConfigFile({
            transform: (current) => {
              const nextConfig = structuredClone(current);
              const agentConfig = nextConfig.agents;
              if (!agentConfig?.defaults) {
                throw new Error("expected migrated agent defaults");
              }
              if (shape === "included-roster") {
                delete agentConfig.defaults;
              } else {
                delete agentConfig.defaults.modelPolicy;
                delete agentConfig.defaults.models;
              }
              return { nextConfig };
            },
          });
          await transformConfigFile({
            transform: (current) => ({
              nextConfig: {
                ...current,
                agents: {
                  ...current.agents,
                  defaults: {
                    ...current.agents?.defaults,
                    models: { "openai/gpt-5.5": { alias: "New metadata" } },
                  },
                },
              },
            }),
          });
          const reloaded = await readConfigFileSnapshot();
          expect(reloaded.valid).toBe(true);
          expect(reloaded.config.agents?.defaults?.modelPolicy).toEqual({});
          expect(reloaded.legacyIssues).toEqual([]);
          expect(
            createModelVisibilityPolicy({
              cfg: reloaded.config,
              catalog: [],
              defaultProvider: "openai",
              agentId: "ops",
            }).allowAny,
          ).toBe(true);
          await expect(
            transformConfigFile({
              transform: (current) => ({
                nextConfig: {
                  ...current,
                  meta: { migrations: { modelPolicyAllowlist: true } },
                  agents: {
                    ...current.agents,
                    defaults: {
                      ...current.agents?.defaults,
                      models: { "openai/gpt-5.5": { alias: "Explicit marker edit" } },
                    },
                  },
                },
              }),
              writeOptions: { explicitSetPaths: [["meta", "migrations", "modelPolicyAllowlist"]] },
            }),
          ).rejects.toThrow("flatten $include-owned config");
          expect((await readConfigFileSnapshot()).sourceConfig).toEqual(reloaded.sourceConfig);
          await expect(fs.readFile(configPath, "utf8")).resolves.toBe(rootRaw);
        });
      });
    },
  );

  it.each([
    { authority: false, refusal: undefined },
    { authority: true, refusal: "requester-revoked" },
    { authority: true, refusal: "config-input-changed" },
  ] as const)(
    "writes a nested agent repair to its fragment and preserves both ancestor files (authority=$authority, refusal=$refusal)",
    async ({ authority, refusal }) => {
      await withDoctorConfigPreflightHome(async (home) => {
        await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
          const configPath = await writeOpenClawConfig(home, {
            agents: { entries: { main: { $include: "./config/main-parent.json5" } } },
            gateway: { mode: "local" },
            plugins: { enabled: false },
          });
          const fragmentDir = path.join(path.dirname(configPath), "config");
          await fs.mkdir(fragmentDir);
          const parentPath = path.join(fragmentDir, "main-parent.json5");
          const parentRaw = '{ /* keep this delegation */ $include: "./main.json5" }\n';
          await fs.writeFile(parentPath, parentRaw);
          const fragmentPath = path.join(fragmentDir, "main.json5");
          const fragmentRaw = JSON.stringify({ sandbox: { browser: { enableNoVnc: true } } });
          await fs.writeFile(fragmentPath, fragmentRaw);
          const rootRaw = await fs.readFile(configPath, "utf-8");

          const ctx = await prepareDoctorContext(configPath);
          expect(ctx.configResult.shouldWriteConfig).toBe(true);
          expect(ctx.configResult.skipWizardMetadataForIncludeWrite).toBe(true);
          const writing = captureUpdateDoctorConfigWrites(
            configPath,
            () => runWriteConfigHealth(ctx, { runPostWriteRepairs: false }),
            authority
              ? {
                  inputHash: hashConfigRaw(refusal === "config-input-changed" ? "{}" : rootRaw),
                  assertCurrent: () => {
                    if (refusal === "requester-revoked") {
                      throw new UpdateRequesterRevokedError();
                    }
                  },
                }
              : undefined,
          );
          if (refusal === "requester-revoked") {
            await expect(writing).rejects.toBeInstanceOf(UpdateRequesterRevokedError);
          } else if (refusal === "config-input-changed") {
            await expect(writing).resolves.toBe(false);
            expect(ctx.configWriteRefusal).toBe("config-conflict");
          } else {
            await writing;
          }
          if (refusal) {
            expect(ctx.configResultWriteCommitted).not.toBe(true);
            await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
            await expect(fs.readFile(parentPath, "utf-8")).resolves.toBe(parentRaw);
            await expect(fs.readFile(fragmentPath, "utf-8")).resolves.toBe(fragmentRaw);
            expect((await fs.readdir(fragmentDir)).toSorted()).toEqual([
              "main-parent.json5",
              "main.json5",
            ]);
            return;
          }

          expect(ctx.configWriteRefusal).toBeUndefined();
          expect(ctx.configResultWriteCommitted).toBe(true);
          expect(JSON.parse(await fs.readFile(fragmentPath, "utf-8"))).toEqual({
            sandbox: { browser: { noVncEnabled: true } },
          });
          await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
          await expect(fs.readFile(parentPath, "utf-8")).resolves.toBe(parentRaw);
        });
      });
    },
  );

  it("refuses a different active config path even when its bytes match", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const ctx = await prepareDoctorContext(configPath);
        const originalBytes = await fs.readFile(configPath, "utf8");
        const otherPath = path.join(path.dirname(configPath), "other-openclaw.json");
        await fs.writeFile(otherPath, originalBytes);
        const files = (await fs.readdir(path.dirname(configPath))).toSorted();
        const receipt = ctx.configResult.confirmedConfigSource;
        const baseline = ctx.cfgForPersistence;
        ctx.cfg = { ...ctx.cfg, gateway: { ...ctx.cfg.gateway, port: 19090 } };

        await withEnvAsync({ OPENCLAW_CONFIG_PATH: otherPath }, async () => {
          const otherSnapshot = await readConfigFileSnapshot();
          expect(otherSnapshot.path).toBe(otherPath);
          expect(otherSnapshot.hash).toBe(receipt?.hash);
          expect(await runWriteConfigHealth(ctx)).toBe(false);
        });

        expect(ctx.configWriteRefusal).toBe("config-conflict");
        expect(ctx.configResult.confirmedConfigSource).toBe(receipt);
        expect(ctx.cfgForPersistence).toBe(baseline);
        await expect(fs.readFile(configPath, "utf8")).resolves.toBe(originalBytes);
        await expect(fs.readFile(otherPath, "utf8")).resolves.toBe(originalBytes);
        expect((await fs.readdir(path.dirname(configPath))).toSorted()).toEqual(files);
      });
    });
  });

  it("creates a missing config using its recorded missing-file revision", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {});
        await fs.unlink(configPath);
        const ctx = await prepareDoctorContext(configPath);
        expect(ctx.configResult.referenceSource).toBeUndefined();
        expect(ctx.configResult.confirmedConfigSource).toEqual({
          path: configPath,
          hash: hashConfigRaw(null),
        });
        ctx.cfg = { gateway: { mode: "local" }, plugins: { enabled: false } };
        expect(await runWriteConfigHealth(ctx, { runPostWriteRepairs: false })).toBe(true);
        const snapshot = await readConfigFileSnapshot();
        expect(snapshot.exists).toBe(true);
        expect(snapshot.valid).toBe(true);
        expect(ctx.configResult.confirmedConfigSource).toEqual({
          path: configPath,
          hash: snapshot.hash,
        });
      });
    });
  });

  it("records the refusal and leaves the root and the included file untouched", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          agents: { list: [{ id: "ops" }] },
          browser: { $include: "./browser.json" },
          gateway: { mode: "local" },
          plugins: { enabled: false },
        });
        const includePath = path.join(path.dirname(configPath), "browser.json");
        const includeRaw = JSON.stringify({ enabled: true, actionTimeoutMs: 5000 });
        await fs.writeFile(includePath, includeRaw);
        const rootRaw = await fs.readFile(configPath, "utf-8");

        const ctx = await prepareDoctorContext(configPath);
        // The legacy roster is a root repair; the retired knob is an include repair.
        expect(ctx.configResult.shouldWriteConfig).toBe(true);
        expect(ctx.configResult.persistCanonicalAgentRoster).toBe(true);
        expect(ctx.cfg.browser).toEqual({ enabled: true });
        const repairPanels = () =>
          noteMock.mock.calls
            .filter(([, title]) => title === "Doctor changes")
            .map(([message]) => message)
            .join("\n");
        expect(repairPanels()).not.toContain("retired runtime tuning knobs");
        expect(repairPanels()).not.toContain("canonical agent roster");

        await expect(runWriteConfigHealth(ctx)).resolves.toBe(false);

        // Neither queued repair reached disk, so neither is reported as done.
        expect(ctx.configWriteRefusal).toBe("include-ownership");
        expect(ctx.configResultWriteCommitted).not.toBe(true);
        expect(repairPanels()).not.toContain("retired runtime tuning knobs");
        expect(repairPanels()).not.toContain("canonical agent roster");
        const warning = noteMock.mock.calls.find(
          ([message, title]) =>
            title === "Doctor warnings" && message.includes("No config changes were written"),
        );
        expect(warning?.[0]).toContain("$include-owned config at browser");
        expect(warning?.[0]).toContain("the included file ./browser.json");
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rootRaw);
        await expect(fs.readFile(includePath, "utf-8")).resolves.toBe(includeRaw);
      });
    });
  });
  it("never reports unpersisted fixes and leaves the config untouched", async () => {
    await withDoctorConfigPreflightHome(async (home) => {
      await withEnvAsync({ OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" }, async () => {
        const configPath = await writeOpenClawConfig(home, {
          gatway: { port: 12345 },
          agents: { defaults: { heartbeat: { every: 5 } } },
          plugins: { enabled: false },
        });
        const rawBefore = await fs.readFile(configPath, "utf-8");
        const ctx = await prepareDoctorContext(configPath);
        const { configResult } = ctx;

        // The unknown-key repair is computed, but held until the write commits.
        expect(configResult.shouldWriteConfig).toBe(true);
        expect(
          (configResult.pendingChangePanels ?? []).some((panel) => panel.includes("gatway")),
        ).toBe(true);
        expect(noteMock.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);

        // The write must refuse gracefully — no throw, no change panel, no file write.
        await expect(runWriteConfigHealth(ctx)).resolves.toBe(false);

        expect(ctx.configWriteRefusal).toBe("validation");
        expect(ctx.configResultWriteCommitted).not.toBe(true);
        expect(noteMock.mock.calls.some(([, title]) => title === "Doctor changes")).toBe(false);
        const warning = noteMock.mock.calls.find(
          ([message, title]) =>
            title === "Doctor warnings" && message.includes("No config changes were written"),
        );
        expect(warning).toBeDefined();
        expect(warning?.[0]).toContain("agents.defaults.heartbeat.every");
        await expect(fs.readFile(configPath, "utf-8")).resolves.toBe(rawBefore);
      });
    });
  });
});
