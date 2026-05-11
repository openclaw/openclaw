import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTH_STORE_VERSION } from "../agents/auth-profiles/constants.js";
import { resolveAuthProfileStoreKey } from "../agents/auth-profiles/paths.js";
import {
  loadPersistedAuthProfileStore,
  savePersistedAuthProfileSecretsStore,
} from "../agents/auth-profiles/persisted.js";
import { saveAuthProfileStore } from "../agents/auth-profiles/store.js";
import { readAuthProfileStorePayloadResult } from "../agents/auth-profiles/sqlite-storage.js";
import { formatCliCommand } from "../cli/command-format.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { baseConfigSnapshot, createTestRuntime } from "./test-runtime-config-helpers.js";

const readConfigFileSnapshotMock = vi.hoisted(() => vi.fn());
const writeConfigFileMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const replaceConfigFileMock = vi.hoisted(() =>
  vi.fn(async (params: { nextConfig: unknown }) => await writeConfigFileMock(params.nextConfig)),
);

const wizardMocks = vi.hoisted(() => ({
  createClackPrompter: vi.fn(),
}));

vi.mock("../config/config.js", async () => ({
  ...(await vi.importActual<typeof import("../config/config.js")>("../config/config.js")),
  readConfigFileSnapshot: readConfigFileSnapshotMock,
  writeConfigFile: writeConfigFileMock,
  replaceConfigFile: replaceConfigFileMock,
}));

vi.mock("../wizard/clack-prompter.js", () => ({
  createClackPrompter: wizardMocks.createClackPrompter,
}));

import { WizardCancelledError } from "../wizard/prompts.js";
import { __testing } from "./agents.commands.add.js";
import { agentsAddCommand } from "./agents.js";

const runtime = createTestRuntime();

function oauthProfileSecretId(agentDir: string, profileId: string): string {
  return createHash("sha256").update(`${agentDir}\0${profileId}`).digest("hex").slice(0, 32);
}

describe("agents add command", () => {
  beforeEach(() => {
    readConfigFileSnapshotMock.mockClear();
    writeConfigFileMock.mockClear();
    replaceConfigFileMock.mockClear();
    wizardMocks.createClackPrompter.mockClear();
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  it("requires --workspace when flags are present", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work" }, runtime, { hasFlags: true });

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("requires --workspace in non-interactive mode", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });

    await agentsAddCommand({ name: "Work", nonInteractive: true }, runtime, {
      hasFlags: false,
    });

    expect(runtime.error).toHaveBeenCalledOnce();
    expect(runtime.error).toHaveBeenCalledWith(
      `Non-interactive agent creation requires --workspace. Re-run ${formatCliCommand("openclaw agents add <id> --workspace <path>")} or omit flags to use the wizard.`,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("exits with code 1 when the interactive wizard is cancelled", async () => {
    readConfigFileSnapshotMock.mockResolvedValue({ ...baseConfigSnapshot });
    wizardMocks.createClackPrompter.mockReturnValue({
      intro: vi.fn().mockRejectedValue(new WizardCancelledError()),
      text: vi.fn(),
      confirm: vi.fn(),
      note: vi.fn(),
      outro: vi.fn(),
    });

    await agentsAddCommand({}, runtime);

    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(writeConfigFileMock).not.toHaveBeenCalled();
  });

  it("copies only portable auth profiles when seeding a new agent store", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-add-auth-copy-"));
    try {
      vi.stubEnv("OPENCLAW_STATE_DIR", root);
      const sourceAgentDir = path.join(root, "main", "agent");
      const destAgentDir = path.join(root, "work", "agent");
      await fs.mkdir(sourceAgentDir, { recursive: true });
      savePersistedAuthProfileSecretsStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai:default": {
              type: "api_key",
              provider: "openai",
              key: "sk-test",
            },
            "github-copilot:default": {
              type: "token",
              provider: "github-copilot",
              token: "gho-test",
            },
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "codex-access",
              refresh: "codex-refresh",
              expires: Date.now() + 60_000,
            },
          },
        },
        sourceAgentDir,
      );

      const result = await __testing.copyPortableAuthProfiles({
        sourceAgentDir,
        destAgentDir,
      });

      expect(result).toEqual({ copied: 2, skipped: 1 });
      const copied = loadPersistedAuthProfileStore(destAgentDir);
      expect(Object.keys(copied?.profiles ?? {}).toSorted()).toEqual([
        "github-copilot:default",
        "openai:default",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("copies portable Codex OAuth profiles without inline token material", async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agents-add-oauth-copy-"));
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = root;
    try {
      const sourceAgentDir = path.join(root, "main", "agent");
      const destAgentDir = path.join(root, "work", "agent");
      const expires = Date.now() + 60_000;
      await fs.mkdir(sourceAgentDir, { recursive: true });
      saveAuthProfileStore(
        {
          version: AUTH_STORE_VERSION,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "codex-copy-access-token",
              refresh: "codex-copy-refresh-token",
              expires,
              copyToAgents: true,
            },
          },
        },
        sourceAgentDir,
      );

      const result = await __testing.copyPortableAuthProfiles({
        sourceAgentDir,
        destAgentDir,
      });

      expect(result).toEqual({ copied: 1, skipped: 0 });
      const copiedRaw = JSON.stringify(
        readAuthProfileStorePayloadResult(resolveAuthProfileStoreKey(destAgentDir)).value,
      );
      expect(copiedRaw).not.toContain("codex-copy-access-token");
      expect(copiedRaw).not.toContain("codex-copy-refresh-token");
      const copied = JSON.parse(copiedRaw) as {
        profiles: Record<string, Record<string, unknown>>;
      };
      const credential = copied.profiles["openai-codex:default"];
      expect(credential).toStrictEqual({
        type: "oauth",
        provider: "openai-codex",
        expires,
        copyToAgents: true,
        oauthRef: {
          source: "openclaw-credentials",
          provider: "openai-codex",
          id: oauthProfileSecretId(destAgentDir, "openai-codex:default"),
        },
      });
    } finally {
      if (previousStateDir === undefined) {
        delete process.env.OPENCLAW_STATE_DIR;
      } else {
        process.env.OPENCLAW_STATE_DIR = previousStateDir;
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not claim skipped OAuth profiles stay shared from a non-main source agent", () => {
    expect(
      __testing.formatSkippedOAuthProfilesMessage({
        sourceAgentId: "default-work",
        sourceIsInheritedMain: false,
      }),
    ).toBe(
      'OAuth profiles were not copied from "default-work"; sign in separately for this agent.',
    );
    expect(
      __testing.formatSkippedOAuthProfilesMessage({
        sourceAgentId: "main",
        sourceIsInheritedMain: true,
      }),
    ).toBe('OAuth profiles stay shared from "main" unless this agent signs in separately.');
  });
});
