// Doctor OAuth sidecar tests cover encrypted sidecar detection and auth repair guidance.
import { createCipheriv, hash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../agents/auth-profiles/runtime-snapshots.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { maybeRepairLegacyOAuthSidecarProfiles } from "./doctor-auth-oauth-sidecar.js";

const states: OpenClawTestState[] = [];

function makePrompter(shouldRepair: boolean) {
  return { confirmAutoFix: vi.fn(async () => shouldRepair) };
}

function profileStore(profileId: string, fields: Record<string, unknown>) {
  return {
    version: 1,
    profiles: { [profileId]: { type: "oauth", provider: "openai-codex", ...fields } },
  };
}

function writeSidecar(
  state: OpenClawTestState,
  ref: { id: string },
  profileId: string,
  material: Record<string, unknown>,
) {
  return state.writeJson(path.join("credentials", "auth-profiles", `${ref.id}.json`), {
    version: 1,
    profileId,
    provider: "openai-codex",
    ...material,
  });
}

async function makeTestState(seed = "legacy-oauth-seed"): Promise<OpenClawTestState> {
  const state = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-oauth-sidecar-",
    env: {
      OPENCLAW_AGENT_DIR: undefined,
      OPENCLAW_AUTH_PROFILE_SECRET_KEY: seed,
    },
  });
  states.push(state);
  return state;
}

function writeLegacyAuthProfiles(
  state: OpenClawTestState,
  store: unknown,
  agentId = "main",
): Promise<string> {
  return state.writeJson(path.join("agents", agentId, "agent", "auth-profiles.json"), store);
}

function encryptLegacySidecarMaterial(params: {
  ref: { id: string };
  profileId: string;
  provider: string;
  seed: string;
  material: Record<string, string>;
}) {
  const iv = Buffer.alloc(12, 7);
  const cipher = createCipheriv(
    "aes-256-gcm",
    hash("sha256", `openclaw:auth-profile-oauth:${params.seed}`, "buffer"),
    iv,
  );
  cipher.setAAD(Buffer.from(`${params.ref.id}\0${params.profileId}\0${params.provider}`, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(params.material), "utf8"),
    cipher.final(),
  ]);
  return {
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    tag: cipher.getAuthTag().toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
  };
}

afterEach(async () => {
  clearRuntimeAuthProfileStoreSnapshots();
  for (const state of states.splice(0)) {
    await state.cleanup();
  }
});

describe("maybeRepairLegacyOAuthSidecarProfiles", () => {
  it("migrates encrypted legacy oauthRef sidecars back to inline OAuth credentials", async () => {
    const seed = "legacy-oauth-seed";
    const state = await makeTestState(seed);
    const profileId = "openai-codex:default";
    const ref = {
      source: "openclaw-credentials" as const,
      provider: "openai-codex" as const,
      id: "0123456789abcdef0123456789abcdef",
    };
    const profile = {
      expires: 1777777777000,
      email: "codex@example.com",
      accountId: "acct_123",
      chatgptPlanType: "pro",
    };
    const auth = {
      ...profileStore(profileId, { ...profile, oauthRef: ref }),
      order: {
        "openai-codex": [profileId],
      },
      lastGood: {
        "openai-codex": profileId,
      },
    };
    const authPath = await writeLegacyAuthProfiles(state, auth);
    const sidecarPath = await writeSidecar(state, ref, profileId, {
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: "BwcHBwcHBwcHBwcH",
        tag: "gSm_Lg58EVO-5wZGQlWHEA",
        ciphertext:
          "4qrZ4-zdgUdttB3gTUNORWdtO4gqLiFgTsilUX3-9RZiN2MLkCDdxQXQ2GfeqN1zi1qb9iURwK0sO0TJZfxO3zULMKNlRgUT",
      },
    });

    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 123,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toStrictEqual([
      `Migrated 1 legacy Codex OAuth profile in ${authPath} to inline credentials (backup: ${authPath}.oauth-ref.123.bak).`,
    ]);
    expect(fs.existsSync(sidecarPath)).toBe(false);
    expect(JSON.parse(fs.readFileSync(`${authPath}.oauth-ref.123.bak`, "utf8"))).toEqual(auth);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual({
      ...auth,
      ...profileStore(profileId, {
        ...profile,
        access: "access-token",
        refresh: "refresh-token",
        idToken: "id-token",
      }),
    });
  });

  it("reports legacy sidecar stores without rewriting when repair is declined", async () => {
    const state = await makeTestState();
    const auth = profileStore("openai-codex:default", {
      oauthRef: {
        source: "openclaw-credentials",
        provider: "openai-codex",
        id: "fedcba9876543210fedcba9876543210",
      },
    });
    const authPath = await writeLegacyAuthProfiles(state, auth);

    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg: {},
      prompter: makePrompter(false),
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([]);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(auth);
  });

  it("repairs the inherited auth owner after it leaves the explicit roster", async () => {
    const seed = "retired-owner-sidecar-seed";
    const state = await makeTestState(seed);
    const profileId = "openai-codex:retired-owner";
    const ref = {
      source: "openclaw-credentials" as const,
      provider: "openai-codex" as const,
      id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    };
    const authPath = await writeLegacyAuthProfiles(
      state,
      profileStore(profileId, {
        oauthRef: ref,
      }),
      "retired-ops",
    );
    const sidecarPath = await writeSidecar(state, ref, profileId, {
      encrypted: encryptLegacySidecarMaterial({
        ref,
        profileId,
        provider: "openai-codex",
        seed,
        material: {
          access: "retired-owner-access",
          refresh: "retired-owner-refresh",
        },
      }),
    });

    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg: {
        agents: {
          ownership: "explicit",
          defaults: { authInheritance: { agentId: "retired-ops" } },
          entries: { research: {}, writer: {} },
        },
      },
      prompter: makePrompter(true),
      now: () => 234,
      env: state.env,
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      `Migrated 1 legacy Codex OAuth profile in ${authPath} to inline credentials (backup: ${authPath}.oauth-ref.234.bak).`,
    ]);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(
      profileStore(profileId, {
        access: "retired-owner-access",
        refresh: "retired-owner-refresh",
      }),
    );
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });

  it("leaves undecryptable legacy sidecars in place and reports re-authentication", async () => {
    const state = await makeTestState("wrong-seed");
    const profileId = "openai-codex:default";
    const ref = {
      source: "openclaw-credentials" as const,
      provider: "openai-codex" as const,
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    };
    const auth = profileStore(profileId, {
      oauthRef: ref,
    });
    const authPath = await writeLegacyAuthProfiles(state, auth);
    const sidecarPath = await writeSidecar(state, ref, profileId, {
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: "BwcHBwcHBwcHBwcH",
        tag: "ZHGhT2cekYFZCOxu8pP0KA",
        ciphertext: "OQPDJez2jSRH4FPxFNNkwEw7PDbClF6Ty6T2l4TLGvr6bdJfhK6VA6ccWwC1xlrR4ENA",
      },
    });

    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg: {},
      prompter: makePrompter(true),
    });

    expect(result.detected).toEqual([authPath]);
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      `Could not decrypt legacy OAuth sidecar for ${profileId} in ${authPath}; re-authenticate this profile.`,
    ]);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(auth);
  });

  it("leaves unreferenced legacy sidecar files in place because external agent dirs may still reference them", async () => {
    const state = await makeTestState();
    const sidecarPath = await state.writeJson(
      path.join("credentials", "auth-profiles", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb.json"),
      {
        version: 1,
        profileId: "openai-codex:deleted",
        provider: "openai-codex",
        access: "orphaned-access-token",
        refresh: "orphaned-refresh-token",
      },
    );

    const prompter = makePrompter(true);
    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg: {},
      prompter,
    });

    expect(result.detected).toEqual([sidecarPath]);
    expect(result.changes).toStrictEqual([]);
    expect(result.warnings).toStrictEqual([
      "Found 1 unreferenced legacy Codex OAuth sidecar credential file; left in place because external agent directories outside this scan may still reference it.",
    ]);
    expect(fs.existsSync(sidecarPath)).toBe(true);
    expect(prompter.confirmAutoFix).not.toHaveBeenCalled();
  });

  it.runIf(process.platform !== "win32")(
    "scans symlinked state agents before treating sidecars as unreferenced",
    async () => {
      const state = await makeTestState();
      const ref = {
        source: "openclaw-credentials" as const,
        provider: "openai-codex" as const,
        id: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      };
      const profileId = "openai-codex:linked";
      const realAgentRoot = state.path("real-linked-agent-root");
      const realAgentDir = path.join(realAgentRoot, "agent");
      const symlinkRoot = state.path("state", "agents", "linked");
      const symlinkAuthPath = path.join(symlinkRoot, "agent", "auth-profiles.json");
      fs.mkdirSync(realAgentDir, { recursive: true });
      fs.mkdirSync(path.dirname(symlinkRoot), { recursive: true });
      fs.symlinkSync(realAgentRoot, symlinkRoot, "dir");
      fs.writeFileSync(
        path.join(realAgentDir, "auth-profiles.json"),
        `${JSON.stringify(
          profileStore(profileId, {
            oauthRef: ref,
          }),
          null,
          2,
        )}\n`,
        "utf8",
      );
      const sidecarPath = await writeSidecar(state, ref, profileId, {
        access: "linked-access-token",
        refresh: "linked-refresh-token",
      });

      const result = await maybeRepairLegacyOAuthSidecarProfiles({
        cfg: {},
        prompter: makePrompter(true),
      });

      expect(result.detected).toEqual([symlinkAuthPath]);
      expect(result.warnings).toStrictEqual([]);
      expect(result.changes).toHaveLength(1);
      expect(
        JSON.parse(fs.readFileSync(path.join(realAgentDir, "auth-profiles.json"), "utf8")),
      ).toEqual(
        profileStore(profileId, {
          access: "linked-access-token",
          refresh: "linked-refresh-token",
        }),
      );
      expect(fs.existsSync(sidecarPath)).toBe(false);
    },
  );

  it.each(["OPENCLAW_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const)(
    "scans %s before treating sidecars as unreferenced",
    async (envName) => {
      const state = await makeTestState();
      const previousAgentDir = process.env[envName];
      const agentDir = state.path("external-agent");
      const authPath = path.join(agentDir, "auth-profiles.json");
      const profileId = "openai-codex:external";
      const ref = {
        source: "openclaw-credentials",
        provider: "openai-codex",
        id: "dddddddddddddddddddddddddddddddd",
      };
      try {
        fs.mkdirSync(agentDir, { recursive: true });
        fs.writeFileSync(
          authPath,
          JSON.stringify(profileStore(profileId, { oauthRef: ref })),
          "utf8",
        );
        process.env[envName] = agentDir;
        const material = { access: "external-access-token", refresh: "external-refresh-token" };
        const sidecarPath = await writeSidecar(state, ref, profileId, material);

        const result = await maybeRepairLegacyOAuthSidecarProfiles({
          cfg: {},
          prompter: makePrompter(true),
          now: () => 789,
        });

        expect(result.detected).toEqual([authPath]);
        expect(result.warnings).toStrictEqual([]);
        expect(result.changes).toStrictEqual([
          `Migrated 1 legacy Codex OAuth profile in ${authPath} to inline credentials (backup: ${authPath}.oauth-ref.789.bak).`,
        ]);
        expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(
          profileStore(profileId, material),
        );
        expect(fs.existsSync(sidecarPath)).toBe(false);
      } finally {
        if (previousAgentDir === undefined) {
          delete process.env[envName];
        } else {
          process.env[envName] = previousAgentDir;
        }
      }
    },
  );

  it("migrates every store before removing a shared legacy sidecar", async () => {
    const seed = "shared-sidecar-seed";
    const state = await makeTestState(seed);
    const profileId = "openai-codex:default";
    const ref = {
      source: "openclaw-credentials" as const,
      provider: "openai-codex" as const,
      id: "cccccccccccccccccccccccccccccccc",
    };
    const auth = profileStore(profileId, {
      oauthRef: ref,
    });
    const mainAuthPath = await writeLegacyAuthProfiles(state, auth, "main");
    const workerAuthPath = await writeLegacyAuthProfiles(state, auth, "worker");
    const sidecarPath = await writeSidecar(state, ref, profileId, {
      encrypted: {
        algorithm: "aes-256-gcm",
        iv: "BwcHBwcHBwcHBwcH",
        tag: "91XpNgcMQ-AVeo7NDnv11Q",
        ciphertext:
          "fVMsIFtJ0LX1ayciusBnyS7KulJU2dCAdkKU4yMLGYTVB-Gq0X_SvUqPTkAX_a1ZBIjGIC6nFH_3HvhWHMIX7Cs",
      },
    });

    const result = await maybeRepairLegacyOAuthSidecarProfiles({
      cfg: {},
      prompter: makePrompter(true),
      now: () => 456,
    });

    expect(result.detected).toEqual([mainAuthPath, workerAuthPath]);
    expect(result.warnings).toStrictEqual([]);
    expect(result.changes).toEqual([
      `Migrated 1 legacy Codex OAuth profile in ${mainAuthPath} to inline credentials (backup: ${mainAuthPath}.oauth-ref.456.bak).`,
      `Migrated 1 legacy Codex OAuth profile in ${workerAuthPath} to inline credentials (backup: ${workerAuthPath}.oauth-ref.456.bak).`,
    ]);
    for (const authPath of [mainAuthPath, workerAuthPath]) {
      expect(JSON.parse(fs.readFileSync(authPath, "utf8"))).toEqual(
        profileStore(profileId, {
          access: "shared-access-token",
          refresh: "shared-refresh-token",
        }),
      );
    }
    expect(fs.existsSync(sidecarPath)).toBe(false);
  });
});
