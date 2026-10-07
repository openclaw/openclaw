// Real config CLI coverage for legacy roster input, canonical writes, and ownership.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { describe, expect, it, vi } from "vitest";
import { resolveAgentWorkspaceDir } from "../agents/agent-scope-config.js";
import { resolveLegacyInheritedAuthAgentId } from "../agents/legacy-inherited-auth-dir.js";
import { readConfigFileSnapshot } from "../config/config.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { captureEnv, deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import { formatCliCommand } from "./command-format.js";
import { useConfigCliIntegrationHarness } from "./config-cli.integration.test-harness.js";

const cronOwnerRefusal = await import("../config/io.cron-owner-refusal.js");
const {
  registeredRuntimeLogs: logs,
  registeredRuntimeErrors: errors,
  runRegisteredConfigCommand: invoke,
  withConfigFileHarness: withFile,
} = useConfigCliIntegrationHarness();

const read = (file: string) => fs.readFileSync(file, "utf8");
const load = (file: string) => JSON5.parse(read(file));
const run = (...args: string[]) => invoke(["config", ...args]);
const set = (...args: string[]) => invoke(["config", "set", ...args]);
const reject = (result: Promise<unknown>) =>
  expect(result).rejects.toMatchObject({ name: "ExitError", code: 1 });
const withConfig = (raw: string, visit: Parameters<typeof withFile>[2]) =>
  withFile("config-cli-", raw, visit);

describe("config cli roster integration", () => {
  it("preserves a shorthand subagent primary through an indexed roster edit", async () => {
    const raw = JSON.stringify({
      agents: { entries: { main: { subagents: { model: "fixture-model/allowed" } } } },
    });
    await withConfig(raw, async ({ configPath }) => {
      await set(
        "agents.list[0].subagents.model.fallbacks[0]",
        '"fixture-model/backup"',
        "--strict-json",
      );
      const saved = load(configPath);
      expect(saved.agents.entries.main.subagents.model).toEqual({
        primary: "fixture-model/allowed",
        fallbacks: ["fixture-model/backup"],
      });
      expect(saved.agents).not.toHaveProperty("list");
      expect(read(`${configPath}.bak`)).toBe(raw);
      expect(errors).toEqual([]);
    });
  });

  it("validates a surviving SecretRef after its agent is renamed within the batch", async () => {
    const raw = JSON.stringify({
      agents: { entries: { main: {} } },
      secrets: { providers: { default: { source: "env" } } },
    });
    await withConfig(raw, async ({ configPath }) => {
      const envSnapshot = captureEnv(["MISSING_TEST_SECRET"]);
      try {
        deleteTestEnvValue("MISSING_TEST_SECRET");
        await reject(
          set(
            "--batch-json",
            JSON.stringify([
              {
                path: "agents.list[0].memory.search.remote.apiKey",
                ref: { source: "env", provider: "default", id: "MISSING_TEST_SECRET" },
              },
              { path: "agents.list[0].id", value: "work" },
              { path: "agents.entries.main", value: {} },
            ]),
            "--dry-run",
            "--json",
          ),
        );

        expect(read(configPath)).toBe(raw);
        expect(JSON.parse(logs.join("\n"))).toMatchObject({
          ok: false,
          refsChecked: 1,
          errors: [{ kind: "resolvability", ref: "env:default:MISSING_TEST_SECRET" }],
        });
      } finally {
        envSnapshot.restore();
      }
    });
  });

  const originalEntries = {
    main: { name: "original-main" },
    worker: { name: "original-worker" },
  };
  const changedEntries = { ...originalEntries, main: { name: "changed-main" } };
  const changedList = Object.entries(changedEntries).map(([id, entry]) =>
    Object.assign({ id }, entry),
  );
  it("persists an indexed roster edit after a read-only preview", async () => {
    const agents = {
      ownership: "explicit",
      entries: originalEntries,
    };
    const raw = `${JSON.stringify({ agents })}\n`;
    await withConfig(raw, async ({ configPath }) => {
      const args = ["set", "agents.list[0].name", "changed-main"];
      await run(...args, "--dry-run");
      expect(read(configPath)).toBe(raw);
      await run(...args);
      const after = load(configPath);
      expect(after.agents.entries).toEqual(changedEntries);
      expect(after.agents).not.toHaveProperty("list");
      expect(errors).toEqual([]);
    });
  });

  it("requires Doctor before editing a persisted legacy roster", async () => {
    const raw = JSON.stringify({
      agents: {
        ownership: "explicit",
        list: Object.entries(originalEntries).map(([id, entry]) => Object.assign({ id }, entry)),
      },
    });
    await withConfig(raw, async ({ configPath }) => {
      for (const preview of [true, false]) {
        await reject(set("agents.list[0].name", "changed-main", ...(preview ? ["--dry-run"] : [])));
        expect(read(configPath)).toBe(raw);
        expect(fs.existsSync(`${configPath}.bak`)).toBe(false);
      }
      expect(errors.join("\n")).toContain("doctor --fix");
      expect(logs.join("\n")).not.toContain("Updated");
    });
  });

  it("keeps submitted numeric list order through later indexed batch edits", async () => {
    const entries = { "1": { name: "first" }, "2": { name: "second" } };
    const raw = `${JSON.stringify({ agents: { ownership: "explicit", entries } })}\n`;
    await withConfig(raw, async ({ configPath }) => {
      const args = [
        "config",
        "set",
        "--batch-json",
        JSON.stringify([
          {
            path: "agents.list",
            value: [
              { id: "2", name: "second" },
              { id: "1", name: "first" },
            ],
          },
          { path: "agents.entries.1.name", value: "changed-first" },
          { path: "agents.list[0].name", value: "changed-second" },
        ]),
      ];
      await invoke([...args, "--dry-run"]);
      expect(read(configPath)).toBe(raw);
      await invoke(args);
      expect(load(configPath).agents.entries).toEqual({
        "1": { name: "changed-first" },
        "2": { name: "changed-second" },
      });
    });
  });

  it.each(["agentDir", "session.store"])(
    "preserves the physical owner when config set assigns an equivalent reference to %s",
    async (ownerPath) => {
      await withConfig("{}", async ({ configPath, tempDir }) => {
        const physicalPath = path.join(
          fs.realpathSync(tempDir),
          ownerPath === "agentDir" ? "custom-agent" : "sessions.sqlite",
        );
        const original = {
          agents: {
            ...(ownerPath === "session.store"
              ? { defaults: { sessionStore: { agentId: "main" } } }
              : {}),
            entries: {
              main: ownerPath === "agentDir" ? { agentDir: physicalPath } : {},
            },
          },
          ...(ownerPath === "session.store" ? { session: { store: physicalPath } } : {}),
        };
        const raw = `${JSON.stringify(original)}\n`;
        fs.writeFileSync(configPath, raw);
        const envSnapshot = captureEnv(["CONFIG_OWNER_PATH"]);
        try {
          setTestEnvValue("CONFIG_OWNER_PATH", physicalPath);
          expect((await readConfigFileSnapshot()).valid).toBe(true);
          try {
            await set(
              ownerPath === "agentDir" ? "agents.entries.main.agentDir" : "session.store",
              "${CONFIG_OWNER_PATH}",
            );
          } finally {
            expect(errors).toEqual([]);
          }
          const saved = load(configPath);
          const reloaded = await readConfigFileSnapshot();
          expect(reloaded.valid).toBe(true);
          if (ownerPath === "agentDir") {
            expect(saved.agents.entries.main.agentDir).toBe("${CONFIG_OWNER_PATH}");
            expect(reloaded.sourceConfig.agents?.entries?.main?.agentDir).toBe(physicalPath);
            expect(resolveLegacyInheritedAuthAgentId(reloaded.config)).toBe("main");
          } else {
            expect(saved.session.store).toBe("${CONFIG_OWNER_PATH}");
            expect(reloaded.sourceConfig.session?.store).toBe(physicalPath);
            expect(saved.agents.defaults.sessionStore.agentId).toBe("main");
            expect(resolveSessionStoreCompatibilityAgentId(reloaded.config)).toBe("main");
          }
          expect(read(`${configPath}.bak`)).toBe(raw);
          expect(errors).toEqual([]);
        } finally {
          envSnapshot.restore();
        }
      });
    },
  );

  it("preserves included reference identity and escaped literals", async () => {
    await withConfig("{}", async ({ configPath, tempDir }) => {
      const browser = { enabled: true, executablePath: "${CONFIG_REFERENCE_A}" };
      const browserPath = path.join(tempDir, "browser.json");
      const original = {
        agents: { entries: { main: {} } },
        browser: { $include: "./browser.json" },
      };
      const rootRaw = `${JSON.stringify(original)}\n`;
      const ownedPath = browserPath;
      const ownedRaw = `${JSON.stringify(browser)}\n`;
      fs.writeFileSync(configPath, rootRaw);
      fs.writeFileSync(browserPath, ownedRaw);
      const readBrowser = () => load(ownedPath);
      const envSnapshot = captureEnv(["CONFIG_REFERENCE_A", "CONFIG_REFERENCE_B"]);
      try {
        setTestEnvValue("CONFIG_REFERENCE_A", "/opt/example/browser");
        setTestEnvValue("CONFIG_REFERENCE_B", "/opt/example/browser");
        await set("browser.executablePath", "${CONFIG_REFERENCE_B}");
        expect(readBrowser().executablePath).toBe("${CONFIG_REFERENCE_B}");
        expect((await readConfigFileSnapshot()).sourceConfig.browser?.executablePath).toBe(
          "/opt/example/browser",
        );
        expect(read(`${ownedPath}.bak`)).toBe(ownedRaw);

        await set("browser.executablePath", "$${CONFIG_REFERENCE_A}");
        const escapedRaw = read(ownedPath);
        expect(readBrowser().executablePath).toBe("$${CONFIG_REFERENCE_A}");
        await set("browser.enabled", "false");
        expect(readBrowser()).toMatchObject({
          enabled: false,
          executablePath: "$${CONFIG_REFERENCE_A}",
        });
        const reloaded = await readConfigFileSnapshot();
        expect(reloaded.valid).toBe(true);
        expect(reloaded.sourceConfig.browser?.executablePath).toBe("${CONFIG_REFERENCE_A}");
        expect(read(`${ownedPath}.bak`)).toBe(escapedRaw);
        const beforeMerge = read(ownedPath);
        await set("browser", '{"enabled":true}', "--strict-json", "--merge");
        expect(readBrowser()).toMatchObject({
          enabled: true,
          executablePath: "$${CONFIG_REFERENCE_A}",
        });
        expect(read(`${ownedPath}.bak`)).toBe(beforeMerge);
        const beforeActivation = read(ownedPath);
        await set(
          "--batch-json",
          JSON.stringify([
            { path: "browser.executablePath", value: "${CONFIG_REFERENCE_A}" },
            { path: "browser.enabled", value: false },
          ]),
        );
        expect(readBrowser().executablePath).toBe("${CONFIG_REFERENCE_A}");
        expect((await readConfigFileSnapshot()).sourceConfig.browser?.executablePath).toBe(
          "/opt/example/browser",
        );
        expect(read(`${ownedPath}.bak`)).toBe(beforeActivation);
        expect(read(configPath)).toBe(rootRaw);
        expect(errors).toEqual([]);
      } finally {
        envSnapshot.restore();
      }
    });
  });

  it("preserves merged array ownership when an unchanged reference accompanies a sibling edit", async () => {
    await withConfig("{}", async ({ configPath, tempDir }) => {
      const includePath = path.join(tempDir, "gateway.json");
      const includedRaw = `${JSON.stringify({
        mode: "local",
        controlUi: { allowedOrigins: ["https://included.example"] },
      })}\n`;
      const original = {
        agents: { entries: { main: {} } },
        gateway: {
          $include: "./gateway.json",
          controlUi: { allowedOrigins: ["${CONFIG_ROOT_ORIGIN}"] },
        },
      };
      fs.writeFileSync(includePath, includedRaw);
      fs.writeFileSync(configPath, `${JSON.stringify(original)}\n`);
      const envSnapshot = captureEnv(["CONFIG_ROOT_ORIGIN", "CONFIG_ALT_ORIGIN"]);
      try {
        setTestEnvValue("CONFIG_ROOT_ORIGIN", "https://root.example");
        setTestEnvValue("CONFIG_ALT_ORIGIN", "https://root.example");
        await set("gateway.controlUi.enabled", "false");
        const committedRaw = read(configPath);
        expect(JSON5.parse(committedRaw).gateway.controlUi.allowedOrigins).toEqual([
          "${CONFIG_ROOT_ORIGIN}",
        ]);
        const committedBackup = read(`${configPath}.bak`);
        const inventory = fs.readdirSync(tempDir).toSorted();
        await reject(set("gateway.controlUi.allowedOrigins[1]", "${CONFIG_ALT_ORIGIN}"));
        expect(errors).toEqual([expect.stringContaining("$include-owned")]);
        expect(read(configPath)).toBe(committedRaw);
        expect(read(includePath)).toBe(includedRaw);
        expect(read(`${configPath}.bak`)).toBe(committedBackup);
        expect(fs.readdirSync(tempDir).toSorted()).toEqual(inventory);
      } finally {
        envSnapshot.restore();
      }
    });
  });

  it("preserves untouched escaped references when model arrays merge by id", async () => {
    const raw = JSON.stringify({
      models: {
        providers: {
          example: {
            baseUrl: "https://provider.example/v1",
            api: "openai-completions",
            models: [
              { id: "first", name: "$${CONFIG_MODEL_NAME}" },
              { id: "second", name: "Second" },
            ],
          },
        },
      },
    });
    await withConfig(raw, async ({ configPath }) => {
      const envSnapshot = captureEnv(["CONFIG_MODEL_NAME"]);
      try {
        setTestEnvValue("CONFIG_MODEL_NAME", "Activated model name");
        await set(
          "models.providers.example.models",
          '[{"id":"second","contextWindow":8192}]',
          "--strict-json",
          "--merge",
        );
        const saved = load(configPath);
        expect(saved.models.providers.example.models).toEqual([
          { id: "first", name: "$${CONFIG_MODEL_NAME}" },
          { id: "second", name: "Second", contextWindow: 8192 },
        ]);
        expect(
          (await readConfigFileSnapshot()).sourceConfig.models?.providers?.example?.models[0]?.name,
        ).toBe("${CONFIG_MODEL_NAME}");
        expect(read(`${configPath}.bak`)).toBe(raw);
        expect(errors).toEqual([]);
      } finally {
        envSnapshot.restore();
      }
    });
  });

  it("requires explicit ownership before activating an escaped agentDir", async () => {
    await withConfig("{}", async ({ configPath, tempDir }) => {
      const root = fs.realpathSync(tempDir);
      const agentDir = path.join(root, "$${CONFIG_OWNER}");
      const activeDir = path.join(root, "${CONFIG_OWNER}");
      const raw = `${JSON.stringify({
        agents: { entries: { main: { agentDir } } },
        browser: { enabled: true },
      })}\n`;
      fs.writeFileSync(configPath, raw);
      const inventory = fs.readdirSync(tempDir).toSorted();
      const envSnapshot = captureEnv(["CONFIG_OWNER"]);
      try {
        setTestEnvValue("CONFIG_OWNER", "other-agent");
        expect((await readConfigFileSnapshot()).valid).toBe(true);
        const operations = [
          { path: "agents.entries.main.agentDir", value: activeDir },
          { path: "browser.enabled", value: false },
        ];
        await reject(set("--batch-json", JSON.stringify(operations)));
        expect(errors).toEqual([expect.stringContaining("inherited auth")]);
        expect(read(configPath)).toBe(raw);
        expect(fs.readdirSync(tempDir).toSorted()).toEqual(inventory);
        errors.length = 0;

        await set(
          "--batch-json",
          JSON.stringify([
            ...operations,
            { path: "agents.defaults.authInheritance.agentId", value: "main" },
          ]),
        );
        const saved = load(configPath);
        expect(saved.agents.entries.main.agentDir).toBe(activeDir);
        expect(saved.agents.defaults.authInheritance.agentId).toBe("main");
        expect((await readConfigFileSnapshot()).sourceConfig.agents?.entries?.main?.agentDir).toBe(
          path.join(root, "other-agent"),
        );
        expect(read(`${configPath}.bak`)).toBe(raw);
        expect(errors).toEqual([]);
      } finally {
        envSnapshot.restore();
      }
    });
  });

  it.each([
    { name: "entry recreated", removed: { main: null }, main: { name: "changed-main" } },
    { name: "leaf remains deleted", removed: { main: { name: null } }, main: {} },
  ])("honors mixed patch ordering when $name", async ({ removed, main }) => {
    const raw = JSON.stringify({ agents: { ownership: "explicit", entries: originalEntries } });
    await withConfig(raw, async ({ configPath, tempDir }) => {
      const patchPath = path.join(tempDir, "patch.json");
      fs.writeFileSync(
        patchPath,
        JSON.stringify({
          agents: {
            entries: removed,
            list: [
              { id: "main", ...main },
              { id: "worker", name: "original-worker" },
            ],
          },
        }),
      );
      const args = ["config", "patch", "--file", patchPath];
      await invoke([...args, "--dry-run"]);
      expect(read(configPath)).toBe(raw);
      await invoke(args);
      expect(load(configPath).agents.entries).toEqual({
        main,
        worker: originalEntries.worker,
      });
    });
  });

  it("resets submitted numeric roster order after replacing a null parent", async () => {
    const entries = { "1": { name: "first" }, "2": { name: "second" } };
    const raw = JSON.stringify({
      agents: {
        ownership: "explicit",
        entries,
      },
    });
    await withConfig(raw, async ({ configPath }) => {
      const args = [
        "config",
        "set",
        "--batch-json",
        JSON.stringify([
          {
            path: "agents.list",
            value: [
              { id: "2", name: "second" },
              { id: "1", name: "first" },
            ],
          },
          { path: "agents.entries.2.name", value: "discarded" },
          { path: "agents", value: null },
          { path: "agents.entries.1", value: entries["1"] },
          { path: "agents.entries.2", value: entries["2"] },
          { path: "agents.list[0].name", value: "indexed-change" },
        ]),
        "--replace",
      ];
      await invoke([...args, "--dry-run"]);
      expect(read(configPath)).toBe(raw);
      await invoke(args);
      expect(load(configPath).agents.entries).toEqual({
        ...entries,
        "1": { name: "indexed-change" },
      });
    });
  });

  it.each([
    {
      name: "list to keyed",
      operations: [
        { path: "agents.list", value: [{ id: "main" }, { id: "main" }] },
        { path: "agents.entries", value: changedEntries },
      ],
    },
    {
      name: "malformed keyed to list",
      operations: [
        { path: "agents.entries", value: "discarded" },
        { path: "agents.list", value: changedList },
      ],
    },
    {
      name: "keyed identity to list patch",
      patch: { agents: { entries: { main: { id: "main" } }, list: changedList } },
    },
  ])("validates the final $name replacement instead of a discarded roster", async (scenario) => {
    const raw = JSON.stringify({ agents: { ownership: "explicit", entries: originalEntries } });
    await withConfig(raw, async ({ configPath, tempDir }) => {
      const patchPath = path.join(tempDir, "replacement.json");
      if ("patch" in scenario) {
        fs.writeFileSync(patchPath, JSON.stringify(scenario.patch));
      }
      const args =
        "patch" in scenario
          ? ["config", "patch", "--file", patchPath, "--replace-path", "agents.list"]
          : ["config", "set", "--batch-json", JSON.stringify(scenario.operations), "--replace"];
      await invoke([...args, "--dry-run"]);
      expect(read(configPath)).toBe(raw);
      await invoke(args);
      expect(load(configPath).agents.entries).toEqual(changedEntries);
    });
  });

  it.each(["agents.list[0].model"])(
    "validates model references before writing %s",
    async (modelPath) => {
      const raw = JSON.stringify({ agents: { entries: { main: { name: "unchanged" } } } });
      await withConfig(raw, async ({ configPath }) => {
        await reject(set(modelPath, "missing-roster-provider/missing-model"));
        expect(read(configPath)).toBe(raw);
        expect(errors.join("\n")).toContain(
          'Cannot set model reference "<configured model reference>" at agents.entries.main.model',
        );
        expect(errors.join("\n")).toContain(formatCliCommand("openclaw models list"));
      });
    },
  );

  it.each([
    { name: "duplicate identity", list: [{ id: "main" }, { id: "main" }], error: "duplicate" },
  ])("does not write a legacy roster with $name", async ({ list, error }) => {
    const raw = JSON.stringify({ agents: { ownership: "explicit", entries: originalEntries } });
    await withConfig(raw, async ({ configPath }) => {
      await reject(set("agents.list", JSON.stringify(list), "--replace", "--strict-json"));
      expect(read(configPath)).toBe(raw);
      expect(errors.join("\n")).toContain(error);
      expect(logs.join("\n")).not.toContain("Updated");
    });
  });

  it.each([
    { mode: "legacy agents replacement", ownerId: "main", input: "agents" },
    { mode: "batch changes retired default", ownerId: "keeper", input: "batch" },
    { mode: "explicit destination store owner", ownerId: "keeper", input: "owned-store" },
  ])("preserves ownership intent through $mode preview and write", async (scenario) => {
    const { ownerId, input } = scenario;
    const changedStore = input.endsWith("store");
    const prepareCronOwner = vi.spyOn(cronOwnerRefusal, "prepareCronOwnerWriteRefusal");
    await withConfig("{}", async ({ configPath, tempDir }) => {
      const workspace = path.join(fs.realpathSync(tempDir), "existing-workspace");
      const defaults = {
        workspace,
        ...(changedStore ? { sessionStore: { agentId: ownerId } } : {}),
      };
      const ownerEntry = { name: "original-owner" };
      const original = {
        agents: {
          defaults,
          entries: {
            [ownerId]: ownerEntry,
          },
        },
        session: { store: path.join(fs.realpathSync(tempDir), "sessions.sqlite") },
        channels: { discord: { enabled: true, dmPolicy: "disabled", groupPolicy: "disabled" } },
      };
      const nextStore = changedStore
        ? path.join(fs.realpathSync(tempDir), "destination.sqlite")
        : original.session.store;
      const raw = `${JSON.stringify(original)}\n`;
      fs.writeFileSync(configPath, raw);
      const list = [
        { id: ownerId, ...ownerEntry, default: !changedStore },
        {
          id: "work",
          name: "new-worker",
          ...(changedStore ? { default: true } : {}),
        },
      ];
      let args: string[];
      if (input === "agents") {
        args = ["config", "set", "agents", JSON.stringify({ defaults, list }), "--strict-json"];
      } else {
        const operations = changedStore
          ? [
              {
                path: "agents",
                value: {
                  ownership: "explicit",
                  defaults,
                  entries: { [ownerId]: ownerEntry, work: { name: "new-worker" } },
                },
              },
              { path: "session.store", value: nextStore },
              { path: "agents.defaults.sessionStore.agentId", value: "work" },
            ]
          : [
              { path: "agents.list", value: list },
              { path: `agents.entries.${ownerId}.default`, value: false },
              { path: "agents.entries.work.default", value: true },
            ];
        args = ["config", "set", "--batch-json", JSON.stringify(operations)];
      }
      await invoke([...args, "--dry-run"]);
      expect(read(configPath)).toBe(raw);
      expect(prepareCronOwner).not.toHaveBeenCalled();
      await invoke(args);
      expect(prepareCronOwner).toHaveBeenCalledTimes(1);
      expect(read(`${configPath}.bak`)).toBe(raw);
      const after = load(configPath);
      expect(after.agents).toMatchObject({
        ownership: "explicit",
        defaults: {
          systemAgent: { agentId: ownerId },
        },
      });
      expect(after.agents.entries).toEqual({
        [ownerId]: { name: "original-owner", workspace },
        work: { name: "new-worker" },
      });
      expect(after.agents).not.toHaveProperty("list");
      expect(after.agents.defaults).not.toHaveProperty("heartbeat");
      expect(after.talk.agentId).toBe(ownerId);
      expect(after.bindings).toEqual([
        { agentId: ownerId, match: { channel: "discord", accountId: "*" } },
      ]);
      const reloaded = await readConfigFileSnapshot();
      expect(reloaded.valid).toBe(true);
      expect(resolveAgentWorkspaceDir(reloaded.config, ownerId)).toBe(workspace);
      expect(resolveAgentWorkspaceDir(reloaded.config, "work")).toBe(path.join(workspace, "work"));
      expect(resolveLegacyInheritedAuthAgentId(reloaded.config)).toBe(ownerId);
      expect(after.session.store).toBe(nextStore);
      const expectedStoreOwner = input === "owned-store" ? "work" : ownerId;
      expect(after.agents.defaults.sessionStore.agentId).toBe(expectedStoreOwner);
      expect(resolveSessionStoreCompatibilityAgentId(reloaded.config)).toBe(expectedStoreOwner);
      expect(errors).toEqual([]);
    });
  });
});
