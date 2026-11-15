import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { resolveOAuthDir } from "../config/paths.js";
import {
  readChannelPairingStateSnapshot as readPairing,
  writeChannelPairingStateSnapshot,
} from "../pairing/pairing-store-sqlite.test-helpers.js";
import { closeOpenClawStateDatabaseForTest } from "../state/openclaw-state-db.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import {
  detectLegacyChannelPairingState,
  migrateLegacyChannelPairingState,
} from "./state-migrations.channel-pairing.js";
import { runLegacyStateMigrationSteps } from "./state-migrations.steps.js";

const tempDirs = createTrackedTempDirs();
const createdAt = "2026-01-01T00:00:00.000Z";
const request = {
  id: "pending-user",
  code: "PAIRME12",
  createdAt,
  lastSeenAt: createdAt,
  meta: { accountId: "alerts" },
};
type DetectionOptions = Omit<Parameters<typeof detectLegacyChannelPairingState>[0], "sourceDir">;

function accounts(accountIds: Record<string, string[]>, configuredChannelIds: string[] = []) {
  return { configuredChannelIds, resolveAccounts: () => ({ accountIds }) };
}

function runWithLaterRepair(run: () => ReturnType<typeof migrateLegacyChannelPairingState>) {
  return runLegacyStateMigrationSteps(
    [run, () => ({ changes: ["Later repair completed"], warnings: [] })].map((step, index) => ({
      id: index === 0 ? "channel-pairing" : "later-repair",
      run: step,
      phase: "final" as const,
      source: [],
      target: [],
      requiredness: "required" as const,
      reversibility: "checkpoint-required" as const,
    })),
  );
}

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await tempDirs.cleanup();
});

async function fixture(files: Record<string, unknown>, options: DetectionOptions = {}) {
  const stateDir = await tempDirs.make("openclaw-pairing-migration-");
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const sourceDir = resolveOAuthDir(env, stateDir);
  fs.mkdirSync(sourceDir, { recursive: true });
  for (const [name, value] of Object.entries(files)) {
    fs.writeFileSync(
      path.join(sourceDir, name),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  }
  const detected = detectLegacyChannelPairingState({ sourceDir, ...options });
  return {
    env,
    sourceDir,
    detected,
    migrate: () => migrateLegacyChannelPairingState({ detected, env }),
    read: (name: string) => fs.readFileSync(path.join(sourceDir, name), "utf8"),
    exists: (name: string) => fs.existsSync(path.join(sourceDir, name)),
  };
}

function expectPreserved(
  state: Awaited<ReturnType<typeof fixture>>,
  names: string[],
  reason: "ambiguous" | "unresolved",
) {
  const warnings = names.map((name) =>
    expect.stringContaining(
      `Legacy channel allowFrom channel/account is ${reason}; left in place at ${path.join(state.sourceDir, name)}`,
    ),
  );
  const result = state.migrate();
  expect(result).toEqual({ changes: [], warnings: expect.arrayContaining(warnings) });
  expect(result.warnings).toHaveLength(names.length);
  expect(names.every(state.exists)).toBe(true);
}

it.each([
  [false, false],
  [true, false],
  [false, true],
])(
  "archives removed accounts: malformed removed=%s / configured=%s",
  async (removedMalformed, configuredMalformed) => {
    const filename = "custom-channel-removed-allowFrom.json";
    const configuredFilename = "custom-channel-active-allowFrom.json";
    const original = removedMalformed ? "{broken\n" : '["former-user"]\n';
    const state = await fixture(
      {
        [filename]: original,
        [`${filename}.migrated`]: original,
        ...(configuredMalformed ? { [configuredFilename]: "{broken\n" } : {}),
      },
      accounts({ "custom-channel": ["active"] }, ["custom-channel"]),
    );
    const source = path.join(state.sourceDir, filename);
    const result = await runWithLaterRepair(state.migrate);
    expect(result.receipts.map((receipt) => receipt.outcome)).toEqual(
      configuredMalformed ? ["refused", "refused"] : ["warning", "completed"],
    );
    const warnings = result.receipts[0]?.warnings.join("\n");
    expect(warnings).toContain(source);
    expect(warnings).toContain(`${source}.migrated.2`);
    expect(state.exists(filename)).toBe(false);
    for (const suffix of [".migrated", ".migrated.2"]) {
      expect(state.read(`${filename}${suffix}`)).toBe(original);
    }
    if (configuredMalformed) {
      expect(state.read(configuredFilename)).toBe("{broken\n");
    }
    expect(readPairing("custom-channel", state.env).allowFrom).toEqual({});
  },
);

it.each([
  ["configured allowFrom", { "custom-channel-allowFrom.json": ["legacy-user"] }, true],
  [
    "pairing requests and built-in explicit default accounts",
    {
      "telegram-pairing.json": { version: 1, requests: [] },
      "whatsapp-default-allowFrom.json": ["legacy-user"],
    },
    false,
  ],
] as const)("defers discovery only for configured allowFrom: %s", async (_, files, deferred) => {
  const resolveAccounts = vi.fn(() => ({ defaultAccountIds: { "custom-channel": "primary" } }));
  const { detected } = await fixture(files, {
    configuredChannelIds: ["custom-channel", "whatsapp"],
    ...(deferred ? { resolveAccounts } : {}),
    deferConfiguredAccountDiscovery: true,
  });
  expect(detected.accountDiscoveryDeferred).toBe(deferred);
  if (deferred) {
    expect(resolveAccounts).not.toHaveBeenCalled();
  }
});

it("imports requests and exact scoped accounts while ignoring invalid candidates", async () => {
  const state = await fixture(
    {
      "telegram-pairing.json": { version: 1, requests: [request] },
      "telegram-allowFrom.json": { version: 1, allowFrom: ["1001", "1001", "*"] },
      "telegram-alerts-allowFrom.json": ["1002"],
      "telegram-Ops_Bot-allowFrom.json": ["1003"],
    },
    accounts({ telegram: ["*", "alerts", "ops/bot", "ops_bot"] }),
  );
  const result = state.migrate();
  expect(result.warnings).toEqual([]);
  expect(fs.readdirSync(state.sourceDir)).toEqual([]);
  expect(readPairing("telegram", state.env)).toEqual({
    version: 1,
    requests: [request],
    allowFrom: { default: ["1001"], alerts: ["1002"], ops_bot: ["1003"] },
  });
});

it("merges authoritative SQLite rows and keeps unreadable sources", async () => {
  const state = await fixture(
    {
      "custom-channel-primary-allowFrom.json": { version: 1, allowFrom: ["imported"] },
      "custom-channel-pairing.json": "{broken\n",
    },
    accounts({ "custom-channel": ["primary"] }, ["custom-channel"]),
  );
  writeChannelPairingStateSnapshot(
    "custom-channel",
    { version: 1, requests: [request], allowFrom: { primary: ["kept"] } },
    state.env,
  );
  expect(state.migrate().warnings).toEqual([
    expect.stringContaining("Legacy channel pairing file unreadable; left in place"),
  ]);
  expect(fs.readdirSync(state.sourceDir)).toEqual(["custom-channel-pairing.json"]);
  expect(readPairing("custom-channel", state.env)).toEqual({
    version: 1,
    requests: [request],
    allowFrom: { primary: ["kept", "imported"] },
  });
});

it.each(["pairing", "allowFrom"] as const)(
  "preserves malformed UTF-8 %s while importing valid sibling state",
  async (kind) => {
    const filename = `custom-channel-${kind}.json`;
    const original = JSON.stringify(
      kind === "pairing" ? { requests: [{ ...request, id: "CORRUPT" }] } : ["CORRUPT"],
    );
    const bytes = Buffer.from(original.replace("CORRUPT", "\x80"), "latin1");
    const state = await fixture(
      {
        [filename]: original,
        "whatsapp-default-allowFrom.json": ["valid-user", "second-user"],
      },
      { configuredChannelIds: ["custom-channel"] },
    );
    fs.writeFileSync(path.join(state.sourceDir, filename), bytes);

    const result = await runWithLaterRepair(state.migrate);

    expect(result.haltedBy).toBeUndefined();
    expect(result.receipts.map((receipt) => receipt.outcome)).toEqual(["warning", "completed"]);
    expect(result.sources[0]?.warnings).toEqual([
      expect.stringContaining("unreadable; left in place"),
    ]);
    expect(fs.readFileSync(path.join(state.sourceDir, filename))).toEqual(bytes);
    expect(readPairing("custom-channel", state.env)).toEqual({
      version: 1,
      requests: [],
      allowFrom: {},
    });
    expect(readPairing("whatsapp", state.env).allowFrom).toEqual({
      default: ["valid-user", "second-user"],
    });
    expect(state.exists("whatsapp-default-allowFrom.json")).toBe(false);
  },
);

it("leaves case-folded filename collision sets in place", async () => {
  const names = ["Ab", "AB"].map((account) => `telegram-${account}-allowFrom.json`);
  const state = await fixture(
    Object.fromEntries(names.map((name, index) => [name, [`user-${index}`]])),
    accounts({ telegram: ["ab"] }),
  );
  const marker = path.join(state.sourceDir, "case-check");
  fs.writeFileSync(marker, "case");
  const caseSensitive = !fs.existsSync(path.join(state.sourceDir, "CASE-CHECK"));
  fs.rmSync(marker);
  if (!caseSensitive) {
    expect(caseSensitive).toBe(false);
    return;
  }
  expectPreserved(state, names, "ambiguous");
  expect(readPairing("telegram", state.env).allowFrom).toEqual({});
});

it.each<[string, Record<string, string[]>, string[], "unresolved" | "ambiguous"]>([
  ["telegram-ops..bot", { telegram: ["ops_bot"] }, [], "unresolved"],
  ["telegram-DEFAULT", { telegram: ["default"] }, [], "unresolved"],
  ["custom-channel-default", { telegram: [] }, ["custom-channel"], "unresolved"],
  ["telegram-business", { telegram: ["business"] }, ["telegram-business"], "ambiguous"],
])("preserves account source %s", async (stem, accountIds, configuredChannelIds, reason) => {
  const filename = `${stem}-allowFrom.json`;
  const state = await fixture({ [filename]: ["1003"] }, accounts(accountIds, configuredChannelIds));
  expectPreserved(state, [filename], reason);
  for (const channel of new Set([...Object.keys(accountIds), ...configuredChannelIds])) {
    expect(readPairing(channel, state.env).allowFrom).toEqual({});
  }
});
