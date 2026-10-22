import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { repairRetiredDoctorState } from "../commands/doctor-retired-state-repair.js";
import { readPluginBindingApprovalsInDatabase as readApprovals } from "../plugins/conversation-binding-state.kernel.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState as readSetting } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { inspectCurrentConversationBindingRecordsInDatabase as readBindings } from "./outbound/current-conversation-bindings.kernel.js";
import { assertNoRetiredRuntimeStateFiles } from "./state-migrations.retired-runtime-files.js";
import { migrateRetiredRuntimeState } from "./state-migrations.retired-runtime.js";
import { runLegacyStateMigrationSteps } from "./state-migrations.steps.js";

const binding = {
  conversation: { channel: "discord", conversationId: "123" },
  targetSessionKey: "agent:main:test",
};
const approval = { pluginRoot: "/plugins/example", pluginId: "example", channel: "discord" };
const collection = (key: string, entry: unknown) => ({ version: 1, [key]: [entry] });
const voiceFile = "settings/voicewake.json";
const bindingsFile = "bindings/current-conversations.json";
const approvalsFile = "plugin-binding-approvals.json";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
    cleanup();
  }),
);
let stateDir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  const home = tempDirs.make("openclaw-retired-runtime-");
  stateDir = path.join(home, ".openclaw");
  env = { ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: stateDir };
});
function write(relative: string, value: unknown) {
  const file = path.join(stateDir, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const bytes = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  fs.writeFileSync(file, bytes);
  return { file, bytes };
}
function migrate() {
  return migrateRetiredRuntimeState({ stateDir, env, assertCurrent() {} });
}
function expectArchived({ file, bytes }: ReturnType<typeof write>, suffix = ".migrated") {
  expect(fs.existsSync(file)).toBe(false);
  expect(fs.readFileSync(`${file}${suffix}`)).toEqual(bytes);
}

it("preserves meaningful settings and bindings while archiving every retired source", async () => {
  const conversation = { ...binding.conversation, accountId: "default" };
  const fixtures = [
    write(voiceFile, { triggers: [" wake up ", "computer"] }),
    write("settings/voicewake-routing.json", {
      version: 1,
      defaultTarget: { agentId: "work" },
      routes: [],
    }),
    write(bindingsFile, collection("bindings", { ...binding, conversation, boundAt: 100 })),
    write(approvalsFile, collection("approvals", { ...approval, approvedAt: 100 })),
    ...[
      "acp/event-ledger.json",
      "acp/event-ledger.json.doctor-import",
      "restart-sentinel.json",
      "restart-sentinel.json.doctor-importing",
      "update-check.json",
    ].map((file) => write(file, '{"retained":"exact bytes"}\n')),
  ];
  const {
    sources: [result],
    haltedBy,
    receipts,
  } = await runLegacyStateMigrationSteps([
    {
      id: "retired-core-state",
      phase: "shared",
      source: [{ kind: "path", path: path.join(stateDir, voiceFile) }],
      target: [],
      requiredness: "required",
      reversibility: "checkpoint-required",
      run: () => repairRetiredDoctorState(env),
    },
  ]);
  expect(haltedBy).toBeUndefined();
  expect(receipts[0]?.outcome).toBe("warning");
  expect(result?.warnings).toHaveLength(fixtures.length);
  expect(readSetting("voicewake.triggers", { env })).toEqual(["wake up", "computer"]);
  expect(readSetting("voicewake.routing", { env })).toMatchObject({
    defaultTarget: { agentId: "work" },
  });
  const { db } = openOpenClawStateDatabase({ env });
  expect(readBindings(db, [conversation])[0]).toMatchObject({
    targetSessionKey: "agent:main:test",
    boundAt: 100,
  });
  expect(readApprovals(db)).toEqual([
    {
      ...approval,
      pluginName: undefined,
      accountId: "default",
      approvedAt: 100,
    },
  ]);
  for (const fixture of fixtures) {
    expectArchived(fixture);
    expect(result?.warnings.join("\n")).toContain(`${fixture.file}.migrated`);
  }
  expect(() => assertNoRetiredRuntimeStateFiles(stateDir, env)).not.toThrow();
  expect(await migrate()).toEqual({ changes: [], warnings: [] });
});

it("keeps canonical settings and preserves a distinct earlier archive", async () => {
  writeConfigMachineState("voicewake.triggers", ["current phrase"], { env });
  const source = write(voiceFile, { triggers: ["legacy phrase"] });
  fs.writeFileSync(`${source.file}.migrated`, "earlier backup");
  await migrate();
  expect(readSetting("voicewake.triggers", { env })).toEqual(["current phrase"]);
  expect(fs.readFileSync(`${source.file}.migrated`, "utf8")).toBe("earlier backup");
  expectArchived(source, ".migrated.2");
});

it("archives malformed meaningful data with recovery instructions and still admits updates", async () => {
  const source = write(voiceFile, "{malformed\n");
  const result = await migrate();
  expect(result.warnings.join("\n")).toContain(
    "Restore the listed trigger phrases through Voice Wake settings",
  );
  expectArchived(source);
  expect(() => assertNoRetiredRuntimeStateFiles(stateDir, env)).not.toThrow();
});

it.each([
  [
    voiceFile,
    { triggers: ["w\u00e3ke up"] },
    "config_machine_state",
    "voicewake.triggers",
  ] as const,
  [
    "settings/voicewake-routing.json",
    { version: 1, defaultTarget: { agentId: "w\u00f6rk" }, routes: [] },
    "config_machine_state",
    "voicewake.routing",
  ] as const,
  [
    bindingsFile,
    collection("bindings", {
      ...binding,
      targetSessionKey: "agent:main:t\u00e9st",
      boundAt: 100,
    }),
    "current_conversation_bindings",
    null,
  ] as const,
  [
    approvalsFile,
    collection("approvals", { ...approval, pluginName: "ex\u00e1mple", approvedAt: 100 }),
    "plugin_binding_approvals",
    null,
  ] as const,
])(
  "refuses %s whose bytes are not valid UTF-8 instead of importing replaced characters",
  async (relative, value, table, settingKey) => {
    // One invalid byte inside a string keeps the JSON parseable, so lossy decoding imports it.
    const bytes = Buffer.from(JSON.stringify(value), "utf8");
    bytes[bytes.indexOf(0xc3)] = 0xff;
    const file = path.join(stateDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);

    const result = await migrate();

    expect(result.warnings.join("\n")).toContain(
      `Could not import ${relative}: Legacy retired state ${relative} must be valid UTF-8`,
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(`${file}.migrated`)).toEqual(bytes);
    if (settingKey) {
      expect(readSetting(settingKey, { env })).toBeUndefined();
    }
    const { db } = openOpenClawStateDatabase({ env });
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({
      count: 0,
    });
    expect(() => assertNoRetiredRuntimeStateFiles(stateDir, env)).not.toThrow();
  },
);

it.each([
  [voiceFile, { triggers: ["retained"] }, "config_machine_state"],
  ["settings/voicewake-routing.json", { version: 1, routes: [] }, "config_machine_state"],
  [bindingsFile, collection("bindings", binding), "current_conversation_bindings"],
  [approvalsFile, collection("approvals", approval), "plugin_binding_approvals"],
] as const)(
  "retains %s after SQLite rejection and retries the import",
  async (relative, value, table) => {
    const source = write(relative, value);
    const { db } = openOpenClawStateDatabase({ env });
    db.exec(
      `CREATE TRIGGER reject_legacy_import BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'synthetic runtime import failure'); END`,
    );
    try {
      await expect(migrate()).rejects.toThrow("synthetic runtime import failure");
      expect(fs.readFileSync(source.file)).toEqual(source.bytes);
      expect(() => assertNoRetiredRuntimeStateFiles(stateDir, env)).toThrow("doctor --fix");
      expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({
        count: 0,
      });
    } finally {
      db.exec("DROP TRIGGER reject_legacy_import");
    }
    await migrate();
    expectArchived(source);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toMatchObject({
      count: 1,
    });
    expect(() => assertNoRetiredRuntimeStateFiles(stateDir, env)).not.toThrow();
  },
);

it("does not import another profile's default-home approval", async () => {
  const source = write(approvalsFile, { version: 1, approvals: [] });
  const profileDir = path.join(path.dirname(stateDir), ".openclaw-work");
  await migrateRetiredRuntimeState({ stateDir: profileDir, env, assertCurrent() {} });
  expect(fs.readFileSync(source.file)).toEqual(source.bytes);
});
