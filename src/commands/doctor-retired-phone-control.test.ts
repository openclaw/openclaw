import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "../plugin-sdk/plugin-state-test-runtime.js";
import {
  finalizeRetiredPhoneControlCleanup,
  prepareRetiredPhoneControlCleanup,
} from "./doctor-retired-phone-control.js";

const seedDeny = [
  "camera.snap",
  "camera.clip",
  "screen.record",
  "computer.act",
  "mobile.ui.observe",
  "mobile.ui.act",
  "contacts.add",
  "calendar.add",
  "reminders.add",
  "sms.send",
  "sms.search",
  "health.summary",
] as const;

let stateDir = "";
let env: NodeJS.ProcessEnv;

function createLeaseJournal() {
  return createPluginStateKeyedStoreForTests<Record<string, unknown>>("phone-control", {
    namespace: "armed",
    maxEntries: 1,
    overflowPolicy: "reject-new",
    env,
  });
}

async function registerLease(overrides: Record<string, unknown>) {
  const store = createLeaseJournal();
  await store.register("generation-1", {
    version: 3,
    generation: "generation-1",
    phase: "active",
    armedAtMs: 1,
    expiresAtMs: 2,
    group: "writes",
    armedCommands: ["sms.send"],
    addedToAllow: [],
    removedFromDeny: [],
    persistentAllows: [],
    ...overrides,
  });
  return store;
}

function config(
  commands: NonNullable<NonNullable<OpenClawConfig["gateway"]>["nodes"]>["commands"],
): OpenClawConfig {
  return { gateway: { nodes: { commands } } };
}

async function writeLegacy(value: unknown) {
  const legacyPath = path.join(stateDir, "plugins", "phone-control", "armed.json");
  await fs.mkdir(path.dirname(legacyPath), { recursive: true });
  await fs.writeFile(legacyPath, JSON.stringify(value));
  return legacyPath;
}

const prepare = (cfg: OpenClawConfig) => prepareRetiredPhoneControlCleanup({ cfg, env });
const commandsOf = (result: Awaited<ReturnType<typeof prepare>>) =>
  result.config.gateway?.nodes?.commands;
function expectUnchanged(result: Awaited<ReturnType<typeof prepare>>, cfg: OpenClawConfig) {
  expect(result.config).toBe(cfg);
  expect(result.configChanges).toEqual([]);
}

beforeEach(async () => {
  resetPluginStateStoreForTests();
  stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-phone-control-retire-"));
  env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
});

afterEach(async () => {
  vi.restoreAllMocks();
  resetPluginStateStoreForTests();
  await fs.rm(stateDir, { recursive: true, force: true });
});

it.each([
  {
    name: "lease-shadowed seed allow",
    lease: { removedFromDeny: ["sms.send"] },
    input: { allow: ["sms.send"], deny: seedDeny.filter((command) => command !== "sms.send") },
    expected: undefined,
  },
  {
    name: "canonical journal over stale legacy state",
    lease: { addedToAllow: ["sms.send"], persistentAllows: ["health.summary"] },
    legacy: { version: 2, addedToAllow: ["health.summary"] },
    input: { allow: ["sms.send", "health.summary"] },
    expected: { allow: ["health.summary"] },
  },
  {
    name: "deny-wins explicit allow",
    input: { allow: ["sms.send"], deny: [...seedDeny] },
    expected: { allow: ["sms.send"], deny: ["sms.send"] },
  },
  {
    name: "operator policy",
    input: { allow: ["sms.send"], deny: [...seedDeny, "custom.command"] },
    expected: { allow: ["sms.send"], deny: [...seedDeny, "custom.command"] },
    unchanged: true,
  },
  {
    name: "restored lease deny",
    lease: { removedFromDeny: ["computer.act"] },
    input: { deny: ["camera.snap", "custom.command"] },
    expected: { deny: ["camera.snap", "custom.command", "computer.act"] },
  },
])("preserves policy for $name", async (scenario) => {
  if (scenario.lease) {
    await registerLease(scenario.lease);
  }
  if (scenario.legacy) {
    await writeLegacy(scenario.legacy);
  }
  const cfg = config(scenario.input);
  const result = await prepare(cfg);
  expect(commandsOf(result)).toEqual(scenario.expected);
  expect(result.cleanupSafe).toBe(true);
  if (scenario.unchanged) {
    expectUnchanged(result, cfg);
  }
});

it.each([
  ["legacy", "malformed"],
  ["canonical", "malformed record"],
  ["unreadable", "Could not inspect retired Phone Control lease state"],
] as const)("preserves policy for malformed %s journals", async (source, message) => {
  if (source === "legacy") {
    await writeLegacy({ version: 3 });
  } else if (source === "canonical") {
    await createLeaseJournal().register("generation-1", { version: 3 });
  } else {
    vi.spyOn(fs, "stat").mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
  }
  const cfg = config({
    deny: [...seedDeny],
    ...(source === "legacy" ? { allow: ["sms.send"] } : {}),
  });
  const result = await prepare(cfg);
  expectUnchanged(result, cfg);
  expect(result.cleanupSafe).toBe(false);
  expect(result.cleanupPending).toBe(true);
  expect(result.warnings).toEqual([expect.stringContaining(message)]);
});

it("preserves policy and original bytes for malformed UTF-8 legacy journals", async () => {
  const legacyPath = await writeLegacy({
    version: 1,
    armedAtMs: 1,
    expiresAtMs: null,
    removedFromDeny: ["CORRUPT"],
  });
  const bytes = Buffer.from(
    (await fs.readFile(legacyPath, "utf8")).replace("CORRUPT", "\x80"),
    "latin1",
  );
  await fs.writeFile(legacyPath, bytes);
  const cfg = config({ deny: ["operator.command"] });

  const result = await prepare(cfg);
  expectUnchanged(result, cfg);
  expect(result.cleanupSafe).toBe(false);
  expect(result.warnings).toEqual([expect.stringContaining("must be valid UTF-8")]);
  expect(await fs.readFile(legacyPath)).toEqual(bytes);
});

it.each([false, true])(
  "finalizes journals only after legacy archival (blocked=%s)",
  async (blocked) => {
    const store = await registerLease({ addedToAllow: ["sms.send"] });
    const legacyPath = await writeLegacy({ version: 2, addedToAllow: ["camera.snap"] });
    if (blocked) {
      await fs.mkdir(`${legacyPath}.migrated`);
    }
    const result = await finalizeRetiredPhoneControlCleanup({ env });
    expect(result.warnings).toHaveLength(blocked ? 1 : 0);
    if (blocked) {
      await expect(store.entries()).resolves.toHaveLength(1);
      await fs.access(legacyPath);
    } else {
      expect(result.changes).toHaveLength(2);
      await expect(store.entries()).resolves.toEqual([]);
      await expect(fs.access(legacyPath)).rejects.toThrow();
      await fs.access(`${legacyPath}.migrated`);
    }
  },
);
