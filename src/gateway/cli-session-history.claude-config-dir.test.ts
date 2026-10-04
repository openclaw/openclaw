import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as cliBackends from "../agents/cli-backends.js";
import {
  clearRuntimeConfigSnapshot,
  getRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import {
  appendTranscriptMessage,
  loadSessionEntry,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import * as sessionHistoryWorkerRuntime from "../config/sessions/session-history-worker-runtime.js";
import { resolveSessionStorePathForScope } from "../config/sessions/session-store-path.js";
import type { InternalSessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { readChatHistoryPage } from "./server-methods/chat-history-pages.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  clearRuntimeConfigSnapshot();
});

type Fixture = {
  cwd: string;
  entry: InternalSessionEntry;
  projectsRoot: string;
  sessionId: string;
  sessionKey: string;
  sourcePath: string;
  storePath: string;
};

async function createFixture(
  state: OpenClawTestState,
  options: {
    configDir?: string;
    cwd?: string;
    bindingRoot?: string;
    sessionKey?: string;
  } = {},
): Promise<Fixture> {
  const cwd = options.cwd ?? state.workspaceDir;
  await fs.mkdir(cwd, { recursive: true });
  vi.stubEnv("HOME", state.home);
  vi.stubEnv("CLAUDE_CONFIG_DIR", options.configDir);
  const sessionKey = options.sessionKey ?? `agent:main:claude-config-${randomUUID()}`;
  const sessionId = randomUUID();
  const cliSessionId = randomUUID();
  const normalizedConfigDir = options.configDir?.normalize("NFC");
  const projectsRoot =
    options.bindingRoot ??
    (normalizedConfigDir === undefined
      ? path.join(state.home, ".claude", "projects")
      : path.resolve(cwd, normalizedConfigDir, "projects"));
  const entry = {
    sessionId,
    updatedAt: Date.now(),
    spawnedCwd: cwd,
    spawnedWorkspaceDir: cwd,
    providerOverride: "claude-cli",
    modelOverride: "claude-sonnet-4-6",
    cliSessionBindings: {
      "claude-cli": {
        sessionId: cliSessionId,
        cwd,
        transcriptRoot: projectsRoot,
      },
    },
  } satisfies InternalSessionEntry;
  const scope = { agentId: "main", sessionKey, sessionId };
  await upsertSessionEntryCore(scope, entry);
  await appendTranscriptMessage(scope, {
    message: { role: "user", content: "Canonical question" },
  });
  await appendTranscriptMessage(scope, {
    message: { role: "assistant", content: "Canonical answer" },
  });
  const projectDir = path.join(projectsRoot, "gateway-config-dir-fixture");
  await fs.mkdir(projectDir, { recursive: true });
  const sourcePath = path.join(projectDir, `${cliSessionId}.jsonl`);
  await fs.writeFile(
    sourcePath,
    `${JSON.stringify({
      type: "assistant",
      uuid: `imported-${cliSessionId}`,
      parentUuid: null,
      sessionId: cliSessionId,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: "Imported answer" },
    })}\n`,
  );
  return {
    cwd,
    entry,
    projectsRoot,
    sessionId,
    sessionKey,
    sourcePath,
    storePath: resolveSessionStorePathForScope({ ...scope, env: state.env }),
  };
}

async function readFixture(
  fixture: Fixture,
  options?: {
    cwd?: string;
    omitCwd?: true;
    retainAuthorization?: Parameters<typeof readChatHistoryPage>[2];
  },
) {
  const requestedCwd = options?.omitCwd ? undefined : (options?.cwd ?? fixture.cwd);
  return await readChatHistoryPage(
    {
      entry: fixture.entry,
      provider: "claude-cli",
      sessionId: fixture.sessionId,
      storePath: fixture.storePath,
      sessionAgentId: "main",
      canonicalKey: fixture.sessionKey,
      max: 20,
      maxHistoryBytes: 100_000,
      effectiveMaxChars: 100_000,
      offset: undefined,
      messageId: undefined,
      ...(requestedCwd ? { cwd: requestedCwd } : {}),
    },
    undefined,
    options?.retainAuthorization,
  );
}

async function withConfig<T>(config: OpenClawConfig, run: () => Promise<T>): Promise<T> {
  const previous = getRuntimeConfigSnapshot();
  setRuntimeConfigSnapshot(config);
  try {
    return await run();
  } finally {
    if (previous) {
      setRuntimeConfigSnapshot(previous);
    } else {
      clearRuntimeConfigSnapshot();
    }
  }
}

describe("Claude CLI history config directory", () => {
  it.each(["unset", "absolute", "relative", "empty", "unicode"] as const)(
    "imports the currently authorized %s profile through the Gateway boundary",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const configDir =
          kind === "unset"
            ? undefined
            : kind === "absolute"
              ? state.path("absolute-claude")
              : kind === "relative"
                ? "relative profile"
                : kind === "empty"
                  ? ""
                  : state.path("cafe\u0301");
        const fixture = await createFixture(state, { configDir });
        const page = await readFixture(fixture);

        expect(page.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
      });
    },
  );

  it("imports an authorized absolute root through the Gateway worker boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const configDir = state.path("absolute-claude");
      const fixture = await createFixture(state, { configDir });
      const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");

      const retainAuthorization = vi.fn<(isCurrent: () => boolean) => void>();
      const page = await readFixture(fixture, { retainAuthorization });
      expect(retainAuthorization).toHaveBeenCalledOnce();
      expect(retainAuthorization.mock.calls[0]?.[0]()).toBe(true);

      expect(page.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
      );
      expect(worker).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "rpc",
          params: expect.objectContaining({
            cliHistoryProjectsRoot: path.join(configDir, "projects"),
          }),
        }),
        undefined,
        expect.any(Function),
      );
    });
  });

  it.each(
    ["explicit", "run", "workspace"].flatMap((source) =>
      ["relative profile", ""].map((configDir) => ({ source, configDir })),
    ),
  )(
    "denies a changed current cwd for a $configDir root from $source before native source I/O",
    async ({ source, configDir }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const firstCwd = state.path("workspace", "first");
        const secondCwd = state.path("workspace", "second");
        const fixture = await createFixture(state, {
          configDir,
          cwd: firstCwd,
        });
        const configForCwd = (cwd: string) =>
          ({
            agents: {
              entries: {
                main: source === "run" ? { cwd } : { workspace: cwd },
              },
            },
          }) satisfies OpenClawConfig;
        if (source !== "explicit") {
          fixture.entry.spawnedCwd = undefined;
          fixture.entry.spawnedWorkspaceDir = undefined;
        }
        const initial =
          source === "explicit"
            ? await readFixture(fixture)
            : await withConfig(configForCwd(firstCwd), () =>
                readFixture(fixture, { omitCwd: true }),
              );
        expect(initial.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
        const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");

        const readDenied = () =>
          readFixture(fixture, source === "explicit" ? { cwd: secondCwd } : { omitCwd: true });
        const page =
          source === "explicit"
            ? await readDenied()
            : await withConfig(configForCwd(secondCwd), readDenied);

        expect(page.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Canonical answer" })]),
        );
        expect(page.messages).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
        expect(worker).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "rpc",
            params: expect.objectContaining({ ignoreCliSessionImports: true }),
          }),
          undefined,
          expect.any(Function),
        );
        expect(worker.mock.calls[0]?.[0]).not.toMatchObject({
          params: { cliHistoryProjectsRoot: expect.anything() },
        });
        expect(fixture.entry.cliSessionBindings?.["claude-cli"]?.transcriptRoot).toBe(
          fixture.projectsRoot,
        );
      });
    },
  );

  it("retains an absolute root across a current cwd change", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const configDir = state.path("absolute-claude");
      const firstCwd = state.path("workspace", "first");
      const secondCwd = state.path("workspace", "second");
      const fixture = await createFixture(state, { configDir, cwd: firstCwd });
      fixture.entry.spawnedCwd = secondCwd;
      fixture.entry.spawnedWorkspaceDir = secondCwd;

      const page = await readFixture({ ...fixture, cwd: secondCwd });

      expect(page.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
      );
    });
  });

  it.each(["changed", "unset"] as const)(
    "denies a retained root when the current profile is %s before native source I/O",
    async (change) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const configDir = state.path("absolute-claude");
        const fixture = await createFixture(state, { configDir });
        const initial = await readFixture(fixture);
        expect(initial.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
        vi.stubEnv(
          "CLAUDE_CONFIG_DIR",
          change === "changed" ? state.path("new-claude-profile") : undefined,
        );
        const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");

        const page = await readFixture(fixture);

        expect(page.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Canonical answer" })]),
        );
        expect(page.messages).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
        expect(worker).toHaveBeenCalledTimes(1);
        expect(worker).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "rpc",
            params: expect.objectContaining({ ignoreCliSessionImports: true }),
          }),
          undefined,
          expect.any(Function),
        );
        expect(worker.mock.calls[0]?.[0]).not.toMatchObject({
          params: { cliHistoryProjectsRoot: expect.anything() },
        });
        expect(fixture.entry.cliSessionBindings?.["claude-cli"]?.transcriptRoot).toBe(
          fixture.projectsRoot,
        );
      });
    },
  );

  it.each(["override", "clear"] as const)(
    "authorizes the current backend %s environment at the Gateway boundary",
    async (kind) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const selectedRoot =
          kind === "override" ? state.path("backend-claude") : path.join(state.home, ".claude");
        const fixture = await createFixture(
          state,
          kind === "override" ? { configDir: selectedRoot } : {},
        );
        vi.stubEnv("CLAUDE_CONFIG_DIR", state.path("gateway-claude-profile"));
        const backend = vi.spyOn(cliBackends, "resolveCliBackendConfig");
        const resolved = (config: Record<string, unknown>) =>
          ({
            id: "claude-cli",
            bundleMcp: false,
            config: { command: "claude", ...config },
          }) as ReturnType<typeof cliBackends.resolveCliBackendConfig>;
        backend.mockReturnValue(
          resolved(
            kind === "override"
              ? { env: { CLAUDE_CONFIG_DIR: selectedRoot } }
              : { clearEnv: ["CLAUDE_CONFIG_DIR"] },
          ),
        );
        const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");

        const imported = await readFixture(fixture);
        expect(imported.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
        expect(worker.mock.calls[0]?.[0]).toMatchObject({
          params: { cliHistoryProjectsRoot: path.join(selectedRoot, "projects") },
        });

        backend.mockReturnValue(
          resolved({ env: { CLAUDE_CONFIG_DIR: state.path("new-profile") } }),
        );
        const denied = await readFixture(fixture);
        expect(denied.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Canonical answer" })]),
        );
        expect(denied.messages).not.toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
        expect(worker.mock.calls[1]?.[0]).toMatchObject({
          params: { ignoreCliSessionImports: true },
        });
      });
    },
  );

  it("applies the current skill-selected profile at the Gateway boundary", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const configDir = state.path("skill-claude");
      const fixture = await createFixture(state, { configDir });
      vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
      const config: OpenClawConfig = {
        skills: { entries: { "selected-profile": { env: { CLAUDE_CONFIG_DIR: configDir } } } },
      };
      fixture.entry.skillsSnapshot = {
        prompt: "",
        skills: [{ name: "selected-profile" }],
      };
      await withConfig(config, async () => {
        const page = await readFixture(fixture);
        expect(page.messages).toEqual(
          expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
        );
      });
      const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");
      await withConfig(
        { skills: { entries: { "selected-profile": { enabled: false } } } },
        async () => {
          const page = await readFixture(fixture);
          expect(page.messages).toEqual(
            expect.arrayContaining([expect.objectContaining({ content: "Canonical answer" })]),
          );
          expect(page.messages).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
          );
        },
      );
      expect(worker).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "rpc",
          params: expect.objectContaining({ ignoreCliSessionImports: true }),
        }),
        undefined,
        expect.any(Function),
      );
    });
  });

  it("does not guess a relative root when the current cwd is unknown", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const firstCwd = state.path("workspace", "first");
      const fixture = await createFixture(state, {
        configDir: "relative-profile",
        cwd: firstCwd,
      });
      fixture.entry.spawnedCwd = undefined;
      fixture.entry.spawnedWorkspaceDir = undefined;
      const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");

      const page = await readFixture(fixture, { omitCwd: true });

      expect(page.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Canonical answer" })]),
      );
      expect(page.messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
      );
      expect(worker).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "rpc",
          params: expect.objectContaining({ ignoreCliSessionImports: true }),
        }),
        undefined,
        expect.any(Function),
      );
    });
  });

  it("isolates node-placed sessions from Gateway-local native files", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await createFixture(state, { configDir: state.path("node-claude") });
      fixture.entry.execHost = "node";
      delete fixture.entry.cliSessionBindings?.["claude-cli"]?.transcriptRoot;
      const worker = vi.spyOn(sessionHistoryWorkerRuntime, "readSessionHistoryPageInWorker");

      const page = await readFixture(fixture);

      expect(page.messages).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
      );
      expect(worker).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "rpc",
          params: expect.objectContaining({ ignoreCliSessionImports: true }),
        }),
        undefined,
        expect.any(Function),
      );
    });
  });

  it("keeps legacy rootless bindings compatible when the current root is authorized", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const fixture = await createFixture(state);
      const originalNativeSessionId = fixture.entry.cliSessionBindings?.["claude-cli"]?.sessionId;
      if (!originalNativeSessionId) {
        throw new Error("Expected the fixture's Claude binding to exist");
      }
      delete fixture.entry.cliSessionBindings?.["claude-cli"]?.transcriptRoot;

      await upsertSessionEntryCore(
        {
          agentId: "main",
          sessionKey: fixture.sessionKey,
        },
        fixture.entry,
      );
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      closeOpenClawAgentDatabasesForTest(state.stateDir);
      const reloaded = loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sessionKey,
        storePath: fixture.storePath,
      });
      if (!reloaded) {
        throw new Error("Expected the persisted Claude binding to reload");
      }
      expect(reloaded.cliSessionBindings?.["claude-cli"]?.transcriptRoot).toBeUndefined();
      expect(reloaded.sessionId).toBe(fixture.sessionId);
      expect(reloaded.cliSessionBindings?.["claude-cli"]?.sessionId).toBe(originalNativeSessionId);
      const page = await readFixture({ ...fixture, entry: reloaded });

      expect(page.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
      );
      expect(page.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: "Canonical question" }),
          expect.objectContaining({ content: "Canonical answer" }),
        ]),
      );

      const scope = {
        agentId: "main",
        sessionKey: fixture.sessionKey,
        sessionId: fixture.sessionId,
      };
      const legacyBinding = reloaded.cliSessionBindings?.["claude-cli"];
      if (!legacyBinding) {
        throw new Error("Expected the reloaded Claude binding to exist");
      }
      await upsertSessionEntryCore(scope, {
        cliSessionBindings: {
          "claude-cli": {
            ...legacyBinding,
            cwd: fixture.cwd,
            transcriptRoot: fixture.projectsRoot,
          },
        },
      });
      await appendTranscriptMessage(scope, {
        message: { role: "assistant", content: "Canonical append after upgrade" },
      });
      await closeOpenClawAgentDatabasesAsync(state.stateDir);
      closeOpenClawAgentDatabasesForTest(state.stateDir);

      const upgraded = loadSessionEntry({
        agentId: "main",
        sessionKey: fixture.sessionKey,
        storePath: fixture.storePath,
      });
      if (!upgraded) {
        throw new Error("Expected the upgraded Claude binding to reload");
      }
      expect(upgraded.sessionId).toBe(fixture.sessionId);
      expect(upgraded.cliSessionBindings?.["claude-cli"]).toMatchObject({
        sessionId: originalNativeSessionId,
        cwd: fixture.cwd,
        transcriptRoot: fixture.projectsRoot,
      });
      const upgradedPage = await readFixture({ ...fixture, entry: upgraded });
      expect(upgradedPage.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ content: "Canonical question" }),
          expect.objectContaining({ content: "Canonical answer" }),
          expect.objectContaining({ content: "Canonical append after upgrade" }),
          expect.objectContaining({ content: "Imported answer" }),
        ]),
      );

      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      expect(database.db.prepare("PRAGMA integrity_check").get()).toEqual({
        integrity_check: "ok",
      });
      expect(database.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });
  });

  it("resolves a symlinked cwd before authorizing a relative root", async () => {
    if (process.platform === "win32") {
      return;
    }
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const realCwd = state.path("workspace", "real");
      const linkedCwd = state.path("workspace", "linked");
      await fs.mkdir(realCwd, { recursive: true });
      await fs.symlink(realCwd, linkedCwd);
      const fixture = await createFixture(state, {
        configDir: "relative-profile",
        cwd: realCwd,
      });
      fixture.entry.spawnedCwd = linkedCwd;
      fixture.entry.spawnedWorkspaceDir = linkedCwd;

      const page = await readFixture(fixture, { cwd: linkedCwd });

      expect(page.messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ content: "Imported answer" })]),
      );
    });
  });
});
