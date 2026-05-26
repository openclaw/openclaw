import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeRepairCanonicalApiKeyFieldAlias } from "./doctor-auth-flat-profiles.js";
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
    prefix: "openclaw-doctor-canonical-api-key-",
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

describe("maybeRepairCanonicalApiKeyFieldAlias", () => {
  it('rewrites the non-canonical "api_key" field to "key" with a backup (57389)', async () => {
    const state = await makeTestState();
    const canonical = {
      version: 1,
      profiles: {
        "my-key": {
          type: "api_key",
          provider: "my-provider",
          api_key: "sk-snake-case-key",
        },
      },
      order: {
        "my-provider": ["my-key"],
      },
    };
    const authPath = await state.writeAuthProfiles(canonical);

    const result = await maybeRepairCanonicalApiKeyFieldAlias({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 123,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([
      `Rewrote 1 "api_key" field(s) to "key" in ${authPath} (backup: ${authPath}.api-key-alias.123.bak).`,
    ]);
    expect(result.warnings).toStrictEqual([]);
    // After the fix: api_key is aliased to the canonical key, other fields untouched.
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({
      version: 1,
      profiles: {
        "my-key": {
          type: "api_key",
          provider: "my-provider",
          key: "sk-snake-case-key",
        },
      },
      order: {
        "my-provider": ["my-key"],
      },
    });
    // The backup preserves the original non-canonical shape.
    expect(JSON.parse(fs.readFileSync(`${authPath}.api-key-alias.123.bak`, "utf8"))).toEqual(
      canonical,
    );
  });

  it('does not touch profiles that already have the canonical "key" field', async () => {
    const state = await makeTestState();
    const canonical = {
      version: 1,
      profiles: {
        "good-key": {
          type: "api_key",
          provider: "my-provider",
          key: "sk-already-canonical",
        },
      },
    };
    const authPath = await state.writeAuthProfiles(canonical);

    const result = await maybeRepairCanonicalApiKeyFieldAlias({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 123,
    });

    expect(result.detected).toStrictEqual([]);
    expect(result.changes).toStrictEqual([]);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(canonical);
    expect(fs.existsSync(`${authPath}.api-key-alias.123.bak`)).toBe(false);
  });

  it('reports the non-canonical "api_key" field without rewriting when repair is declined', async () => {
    const state = await makeTestState();
    const canonical = {
      version: 1,
      profiles: {
        "my-key": {
          type: "api_key",
          provider: "my-provider",
          api_key: "sk-snake-case-key",
        },
      },
    };
    const authPath = await state.writeAuthProfiles(canonical);

    const result = await maybeRepairCanonicalApiKeyFieldAlias({
      cfg: {},
      prompter: makePrompter(false),
      now: () => 123,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([]);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(canonical);
    expect(fs.existsSync(`${authPath}.api-key-alias.123.bak`)).toBe(false);
  });
});
