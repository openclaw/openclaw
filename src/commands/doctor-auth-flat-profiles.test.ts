import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPersistedAuthProfileStore } from "../agents/auth-profiles/persisted.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeRepairLegacyFlatAuthProfileStores } from "./doctor-auth-flat-profiles.js";
import type { DoctorPrompter } from "./doctor-prompter.js";

const states: OpenClawTestState[] = [];

function makePrompter(shouldRepair: boolean): DoctorPrompter {
  return {
    confirm: vi.fn(async () => shouldRepair),
    confirmAutoFix: vi.fn(async () => shouldRepair),
    confirmAggressiveAutoFix: vi.fn(async () => shouldRepair),
    confirmRuntimeRepair: vi.fn(async () => shouldRepair),
    select: vi.fn(async (_params, fallback) => fallback),
    shouldRepair,
    shouldForce: false,
    repairMode: {
      shouldRepair,
      shouldForce: false,
      nonInteractive: false,
      canPrompt: true,
      updateInProgress: false,
    },
  };
}

async function makeTestState(): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-flat-auth-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
    },
  });
  states.push(state);
  return state;
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("maybeRepairLegacyFlatAuthProfileStores", () => {
  it("imports legacy flat auth-profiles.json stores into SQLite with a backup", async () => {
    const state = await makeTestState();
    const legacy = {
      "ollama-windows": {
        apiKey: "ollama-local",
        baseUrl: "http://10.0.2.2:11434/v1",
      },
    };
    const authPath = await state.writeAuthProfiles(legacy);

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 123,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([
      `Rewrote ${authPath} to the canonical auth profile format (backup: ${authPath}.legacy-flat.123.bak).`,
    ]);
    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual({
      version: 1,
      profiles: {
        "ollama-windows:default": {
          type: "api_key",
          provider: "ollama-windows",
          key: "ollama-local",
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(`${authPath}.legacy-flat.123.bak`, "utf8"))).toEqual(legacy);
  });

  it("imports canonical auth-profiles.json stores into SQLite and removes the source", async () => {
    const state = await makeTestState();
    const legacy = {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-openrouter",
        },
      },
    };
    const authPath = await state.writeAuthProfiles(legacy);

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 223,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toHaveLength(1);
    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(authPath)).toBe(false);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual(legacy);
    expect(JSON.parse(fs.readFileSync(`${authPath}.legacy-flat.223.bak`, "utf8"))).toEqual(legacy);
  });

  it("imports retired auth.json stores into SQLite and removes the source", async () => {
    const state = await makeTestState();
    const agentDir = state.agentDir();
    fs.mkdirSync(agentDir, { recursive: true });
    const legacyPath = `${agentDir}/auth.json`;
    const legacy = {
      anthropic: {
        mode: "api_key",
        apiKey: "sk-ant-legacy",
      },
    };
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 234,
    });

    expect(result.detected).toEqual([legacyPath]);
    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${legacyPath}.legacy-auth.234.bak`, "utf8"))).toEqual(
      legacy,
    );
    expect(loadPersistedAuthProfileStore(agentDir)).toEqual({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant-legacy",
        },
      },
    });
  });

  it("imports retired oauth.json into SQLite and removes the source", async () => {
    const state = await makeTestState();
    const legacyPath = state.statePath("credentials", "oauth.json");
    const legacy = {
      "openai-codex": {
        access: "access-token",
        refresh: "refresh-token",
        expires: 1_800_000_000_000,
        accountId: "acct_123",
      },
    };
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 345,
    });

    expect(result.detected).toEqual([legacyPath]);
    expect(result.warnings).toStrictEqual([]);
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${legacyPath}.legacy-oauth.345.bak`, "utf8"))).toEqual(
      legacy,
    );
    expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual({
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-token",
          refresh: "refresh-token",
          expires: 1_800_000_000_000,
          accountId: "acct_123",
        },
      },
    });
  });

  it("reports legacy flat stores without rewriting when repair is declined", async () => {
    const state = await makeTestState();
    const legacy = {
      openai: {
        apiKey: "sk-openai",
      },
    };
    const authPath = await state.writeAuthProfiles(legacy);

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg: {},
      prompter: makePrompter(false),
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([]);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(legacy);
  });

  it("moves aws-sdk auth profile markers into config metadata", async () => {
    const state = await makeTestState();
    const legacy = {
      version: 1,
      profiles: {
        "amazon-bedrock:default": {
          type: "aws-sdk",
          createdAt: "2026-03-15T10:00:00.000Z",
        },
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-openrouter",
        },
      },
    };
    const authPath = await state.writeAuthProfiles(legacy);
    const cfg = {};

    const result = await maybeRepairLegacyFlatAuthProfileStores({
      cfg,
      prompter: makePrompter(true),
      now: () => 456,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toHaveLength(2);
    expect(result.warnings).toStrictEqual([]);
    expect(cfg).toEqual({
      auth: {
        profiles: {
          "amazon-bedrock:default": {
            provider: "amazon-bedrock",
            mode: "aws-sdk",
          },
        },
      },
    });
    expect(fs.existsSync(authPath)).toBe(false);
    expect(loadPersistedAuthProfileStore(state.agentDir())).toEqual({
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-openrouter",
        },
      },
    });
    expect(JSON.parse(fs.readFileSync(`${authPath}.aws-sdk-profile.456.bak`, "utf8"))).toEqual(
      legacy,
    );
  });
});
