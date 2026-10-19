import { afterEach, expect, it, vi } from "vitest";
import {
  validateCronAddParams,
  validateCronUpdateParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  DeliveryThreadIdFieldSchema,
  LowercaseNonEmptyStringFieldSchema,
  TrimmedNonEmptyStringFieldSchema,
} from "./delivery-field-schemas.js";
import { normalizeCronJobCreate, normalizeCronJobPatch } from "./normalize.js";
import { mergeCronPayload } from "./service/payload-merge.js";
import type { CronPayload } from "./types.js";

type UnknownRecord = Record<string, unknown>;

const CRON_SCHEDULE = { kind: "cron", expr: "* * * * *" };
const EVERY_SCHEDULE = { kind: "every", everyMs: 60_000 };
const AGENT_TURN = { kind: "agentTurn", message: "hello" };
const SYSTEM_EVENT = { kind: "systemEvent", text: "hi" };
const AGENT_JOB = {
  name: "test",
  enabled: true,
  schedule: CRON_SCHEDULE,
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: AGENT_TURN,
};
const MAIN_JOB = { sessionTarget: "main", wakeMode: "next-heartbeat", payload: SYSTEM_EVENT };
const GROUP_SESSION = "agent:main:telegram:group:-100123";
const DIRECT_SESSION = "agent:main:telegram:direct:42";
const CUSTOM_SESSION = "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==";
const STALE_SCHEDULE = {
  ...CRON_SCHEDULE,
  ...EVERY_SCHEDULE,
  at: "2026-01-12T18:00:00",
  anchorMs: 123,
  tz: "UTC",
  staggerMs: 30_000,
};
const CHANNEL_REQUESTER = {
  version: 1,
  channel: "discord",
  accountId: "work",
  senderId: "123456789012345678",
};

function normalizeCreate(raw: UnknownRecord, sessionKey?: string): UnknownRecord {
  return normalizeCronJobCreate(
    raw,
    sessionKey ? { sessionContext: { sessionKey } } : undefined,
  ) as unknown as UnknownRecord;
}

const createAgent = (overrides: UnknownRecord = {}, sessionKey?: string) =>
  normalizeCreate({ ...AGENT_JOB, ...overrides }, sessionKey);
const createMain = (overrides: UnknownRecord = {}) => createAgent({ ...MAIN_JOB, ...overrides });
const createDefaulted = (payload: UnknownRecord, overrides: UnknownRecord = {}) =>
  normalizeCreate({ name: "test", schedule: EVERY_SCHEDULE, payload, ...overrides });
const normalizePatch = (raw: UnknownRecord) =>
  normalizeCronJobPatch(raw) as unknown as UnknownRecord;
const child = (record: UnknownRecord, key: string) => record[key] as UnknownRecord;
const provenance = (source: string, channelRequester: unknown) => ({
  version: 1,
  source,
  callerOrigin: { kind: "local" },
  channelRequester,
});
const undefinedFields = (...keys: string[]): UnknownRecord =>
  Object.fromEntries(keys.map((key) => [key, undefined]));
const withAccessor = (base: UnknownRecord, key: string, get: () => unknown) =>
  Object.defineProperty(base, key, { enumerable: true, get });

afterEach(() => vi.restoreAllMocks());

it("does not validate absent delivery fields during create normalization", () => {
  const parsers = [
    LowercaseNonEmptyStringFieldSchema,
    TrimmedNonEmptyStringFieldSchema,
    DeliveryThreadIdFieldSchema,
  ].map((schema) => vi.spyOn(schema, "safeParse"));
  for (const fields of [{}, undefinedFields("channel", "to", "threadId", "accountId")]) {
    expect(createAgent({ delivery: { mode: "none", ...fields } }).delivery).toEqual({
      mode: "none",
    });
  }
  for (const parser of parsers) {
    expect(parser).not.toHaveBeenCalled();
  }
});

const envelopes = {
  scheduledToolPolicy: { version: 1, mode: "trusted" },
  toolsAllowProvenance: provenance("authenticated-requester", CHANNEL_REQUESTER),
  toolsAllowExecTarget: { version: 1, host: "gateway", ask: "always" },
  toolsAllowExecTargetRequirement: {
    version: 1,
    target: { version: 1, host: "gateway", ask: "always" },
    grantIndex: 0,
  },
  runtimeAuthority: {
    version: 1,
    runtimeId: "test-runtime",
    namespace: "test.authority",
    payload: { tools: [{ id: "read", enabled: true }] },
  },
};

it("does not materialize omitted, undefined, or inherited authority fields", () => {
  for (const input of [
    {},
    undefinedFields(...Object.keys(envelopes)),
    Object.create(envelopes) as UnknownRecord,
  ]) {
    const normalized = normalizeCreate(input);
    for (const field of Object.keys(envelopes)) {
      expect(normalized).not.toHaveProperty(field);
    }
  }
});

it("retains valid envelopes without mutating or freezing the input", () => {
  const input = structuredClone(envelopes);

  const normalized = normalizeCreate(input);

  expect(normalized).toMatchObject(envelopes);
  expect(input).toEqual(envelopes);
  const authority = child(normalized, "runtimeAuthority");
  const payload = child(authority, "payload");
  expect(authority).not.toBe(input.runtimeAuthority);
  expect(payload).not.toBe(input.runtimeAuthority.payload);
  for (const item of [authority, payload, (payload.tools as unknown[])[0]]) {
    expect(Object.isFrozen(item)).toBe(true);
  }
  const original = input.runtimeAuthority;
  for (const item of [original, original.payload, original.payload.tools[0]]) {
    expect(Object.isFrozen(item)).toBe(false);
  }
});

it("retains a recovery marker while dropping invalid peer envelopes", () => {
  const normalized = normalizeCreate({
    scheduledToolPolicy: { version: 2, mode: "trusted" },
    toolsAllowProvenance: { version: 2, source: "authenticated-requester" },
    toolsAllowExecTarget: { version: 1, host: "remote" },
    toolsAllowExecTargetRequirement: null,
    runtimeAuthority: { ...envelopes.runtimeAuthority, version: 2 },
  });

  expect(normalized.toolsAllowExecTargetRequirement).toEqual({
    version: 1,
    recoveryRequired: true,
  });
  expect(normalized).not.toHaveProperty("scheduledToolPolicy");
  expect(normalized).not.toHaveProperty("toolsAllowProvenance");
  expect(normalized).not.toHaveProperty("toolsAllowExecTarget");
  expect(normalized).not.toHaveProperty("runtimeAuthority");
});
it.each([
  ["schedule", { kind: "cron" }, { expr: "*/17 * * * *" }, "expr"],
  ["payload", AGENT_TURN, { model: "openai/gpt-5" }, "model"],
] as const)("does not promote prototype-only %s fields", (field, own, inherited, key) => {
  const input = Object.assign(Object.create(inherited) as UnknownRecord, own);
  const normalized =
    field === "schedule" ? createMain({ schedule: input }) : createAgent({ payload: input });
  expect(Object.hasOwn(input, key)).toBe(false);
  expect(child(normalized, field)).not.toHaveProperty(key);
});
const ignoredGetter = vi.fn(() => true);
it.each([
  [
    "authenticated-requester",
    withAccessor(
      {
        ...CHANNEL_REQUESTER,
        channel: " Discord ",
        accountId: " Work ",
        senderId: " 123456789012345678 ",
        roles: ["administrator"],
      },
      "senderIsOwner",
      ignoredGetter,
    ),
    CHANNEL_REQUESTER,
  ],
  ["final-executable-surface", { ...CHANNEL_REQUESTER, senderId: 123 }, undefined],
] as const)(
  "preserves only authored requester facts for %s",
  (source, channelRequester, expected) => {
    const normalized = createAgent({
      toolsAllowProvenance: provenance(source, channelRequester),
    });
    expect(normalized.toolsAllowProvenance).toEqual({
      version: 1,
      source,
      callerOrigin: { kind: "local" },
      ...(expected ? { channelRequester: expected } : {}),
    });
    expect(ignoredGetter).not.toHaveBeenCalled();
  },
);
it("rejects accessor and inherited requester identities without invoking getters", () => {
  const senderGetter = vi.fn(() => CHANNEL_REQUESTER.senderId);
  const accessorRequester = withAccessor({ ...CHANNEL_REQUESTER }, "senderId", senderGetter);
  const inheritedRequester = Object.create(CHANNEL_REQUESTER) as UnknownRecord;
  for (const channelRequester of [accessorRequester, inheritedRequester, undefined]) {
    const normalized = createAgent({
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        channelRequester,
      },
    });
    expect(normalized).not.toHaveProperty("toolsAllowProvenance");
  }
  expect(senderGetter).not.toHaveBeenCalled();
});
it.each<[UnknownRecord, UnknownRecord]>([
  [CRON_SCHEDULE, { tz: " " }],
  [
    { kind: "at", at: "2026-01-12T18:00:00.000Z" },
    { ...STALE_SCHEDULE, kind: "at" },
  ],
  [
    { ...EVERY_SCHEDULE, anchorMs: 123 },
    {
      ...STALE_SCHEDULE,
      everyMs: "60000",
      anchorMs: "123.9",
      staggerMs: "abc",
      command: "leftover",
      cwd: "/x",
    },
  ],
  [
    { kind: "on-exit", command: "make build", cwd: "/repo" },
    { ...STALE_SCHEDULE, kind: "on-exit" },
  ],
  [{ kind: "on-exit", command: " printf %s hello\\ ", cwd: "/repo" }, {}],
])("canonicalizes %j schedules on create and patch", (expected, overrides) => {
  const input = { ...structuredClone(expected), ...overrides };
  const created = createMain({ schedule: input });
  const patch = normalizePatch({ schedule: input });
  expect([created.schedule, patch.schedule]).toEqual([expected, expected]);
  expect(validateCronAddParams(created)).toBe(true);
  expect(validateCronUpdateParams({ id: "job", patch })).toBe(true);
  if (input.kind === "at") {
    expect(created.deleteAfterRun).toBe(true);
  }
});

it.each<[UnknownRecord, number, number | undefined]>([
  [{}, 5 * 60 * 1000, undefined],
  [{ staggerMs: "30000" }, 30_000, 30_000],
])("defaults only omitted create stagger: %j", (input, created, patched) => {
  const schedule = { kind: "cron", expr: "0 * * * *", tz: "UTC", ...input };
  expect(child(createMain({ schedule }), "schedule").staggerMs).toBe(created);
  expect(child(normalizePatch({ schedule }), "schedule").staggerMs).toBe(patched);
});

it("rejects invalid explicit cron stagger before create or patch defaults", () => {
  const schedule = { kind: "cron", expr: "0 * * * *", staggerMs: "abc" };
  expect(() => createMain({ schedule })).toThrow(/staggerMs/);
  expect(() => normalizePatch({ schedule })).toThrow(/staggerMs/);
});

it("normalizes trigger scripts and preserves patch clears", () => {
  expect(
    createMain({ trigger: { script: "  json({ fire: true })  ", once: "true", ignored: true } })
      .trigger,
  ).toEqual({ script: "json({ fire: true })", once: true });
  expect(normalizeCronJobPatch({ trigger: null })).toEqual({ trigger: null });
});

it.each<[UnknownRecord, UnknownRecord]>([
  [{ agentId: " Ops " }, { agentId: "ops" }],
  [{ sessionKey: ` ${GROUP_SESSION} ` }, { sessionKey: GROUP_SESSION }],
  [{ sessionKey: " " }, {}],
])("normalizes authored job fields %j", (input, expected) => {
  expect(normalizePatch(input)).toEqual(expected);
  const created = createAgent(input);
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(expected, key)) {
      expect(created[key]).toEqual(expected[key]);
    } else {
      expect(created).not.toHaveProperty(key);
    }
  }
});

it.each<[string, string | undefined, string, string | undefined]>([
  [" Current ", ` ${DIRECT_SESSION} `, "current", DIRECT_SESSION],
  [CUSTOM_SESSION, undefined, CUSTOM_SESSION, undefined],
])("resolves session target %s", (input, context, target, sessionKey) => {
  const normalized = createAgent({ sessionTarget: input }, context);
  expect(normalized.sessionTarget).toBe(target);
  expect(normalized.sessionKey).toBe(sessionKey);
  expect(normalized.delivery).toEqual({ mode: "announce" });
});

it("preserves custom session separators but rejects null bytes", () => {
  expect(normalizePatch({ sessionTarget: "session:..\\outside" }).sessionTarget).toBe(
    "session:..\\outside",
  );
  expect(() => createAgent({ sessionTarget: "session:bad\0id" })).toThrow(
    "invalid cron sessionTarget session id",
  );
});

it("normalizes delivery fields", () => {
  expect(
    createAgent({
      delivery: { mode: "announce", channel: "telegram", accountId: " ", threadId: 1008013 },
    }).delivery,
  ).toEqual({ mode: "announce", channel: "telegram", threadId: 1008013 });
});

it("normalizes completion destinations without inventing an enclosing mode", () => {
  const delivery = { completionDestination: { mode: " WeBhOoK ", to: " https://x.invalid/c " } };
  const expected = {
    completionDestination: { mode: "webhook", to: "https://x.invalid/c" },
  };
  const created = createMain({
    schedule: EVERY_SCHEDULE,
    wakeMode: "now",
    delivery: { mode: "none", ...delivery },
  });
  const patch = normalizePatch({ delivery });
  expect(created.delivery).toEqual({ mode: "none", ...expected });
  expect(validateCronAddParams(created)).toBe(false);
  expect(patch.delivery).toEqual(expected);
  expect(validateCronUpdateParams({ id: "job", patch })).toBe(true);
});

it.each([
  { channel: null, to: null, threadId: null, accountId: null, failureDestination: null },
  { failureDestination: { channel: null, to: null, accountId: null, mode: null } },
])("preserves nullable delivery patch clears %j", (delivery) => {
  const patch = normalizePatch({ delivery });
  expect(patch.delivery).toEqual(delivery);
  expect(validateCronUpdateParams({ id: "job", patch })).toBe(true);
});

it.each([
  { kind: "agentTurn", field: "message", create: createAgent },
  { kind: "systemEvent", field: "text", create: createMain },
])("normalizes blank $kind text so validation rejects it", ({ kind, field, create }) => {
  const payload = { kind, [field]: "   " };
  const expected = { kind, [field]: "" };
  const created = create({ schedule: EVERY_SCHEDULE, wakeMode: "now", payload });
  expect(created.payload).toEqual(expected);
  expect(validateCronAddParams(created)).toBe(false);
  if (kind === "agentTurn") {
    const patch = normalizePatch({ payload });
    expect(patch.payload).toEqual(expected);
    expect(validateCronUpdateParams({ id: "job", patch })).toBe(false);
  }
});

it("defaults command jobs while retaining argv bytes and normalizing execution options", () => {
  const payload = {
    kind: "command",
    argv: ["printf", "%s", "  padded value  "],
    cwd: "/srv/example",
    env: { FOO: "bar" },
    timeoutSeconds: 30,
    noOutputTimeoutSeconds: 5,
    outputMaxBytes: 4096,
  };
  const normalized = createDefaulted({ ...structuredClone(payload), cwd: " /srv/example " });
  expect(normalized.sessionTarget).toBe("isolated");
  expect(normalized.delivery).toEqual({ mode: "announce" });
  expect(normalized.payload).toEqual(payload);
  expect(validateCronAddParams(normalized)).toBe(true);
});

it("normalizes negative agentTurn timeouts without inventing no-timeout", () => {
  expect(createDefaulted({ ...AGENT_TURN, timeoutSeconds: -5 }).payload).not.toHaveProperty(
    "timeoutSeconds",
  );
  expect(createDefaulted(AGENT_TURN, { timeoutSeconds: -5 }).payload).not.toHaveProperty(
    "timeoutSeconds",
  );
});

it("promotes implicit text payloads with agentTurn hints to agentTurn create jobs", () => {
  const options = { timeoutSeconds: 45, lightContext: true, allowUnsafeExternalContent: true };
  const normalized = createDefaulted({
    text: " summarize the build ",
    model: " openai/gpt-5 ",
    fallbacks: [" anthropic/claude-haiku-3-5 "],
    thinking: " high ",
    ...options,
    toolsAllow: [" read "],
  });
  expect(normalized.sessionTarget).toBe("isolated");
  expect(normalized.delivery).toEqual({ mode: "announce" });
  expect(normalized.payload).toEqual({
    kind: "agentTurn",
    message: "summarize the build",
    model: "openai/gpt-5",
    fallbacks: ["anthropic/claude-haiku-3-5"],
    thinking: "high",
    ...options,
    toolsAllow: ["read"],
  });
  expect(validateCronAddParams(normalized)).toBe(true);
});
it.each<[UnknownRecord, UnknownRecord]>([
  [
    { message: 7, text: null, model: {}, thinking: false, fallbacks: [7], toolsAllow: "read" },
    { message: 7, text: null },
  ],
  [{ outputMaxBytes: 0, toolBudget: -1 }, {}],
  [{ text: " report ", model: " ", thinking: " " }, { text: "report" }],
])("normalizes partial payload %j", (input, expected) => {
  expect(normalizePatch({ payload: input }).payload).toStrictEqual(expected);
});

it.each([
  { model: null, thinking: null, fallbacks: null, toolsAllow: null },
  { fallbacks: [], toolsAllow: [] },
])("normalizes explicit agentTurn overrides %j", (input) => {
  const expected = structuredClone(input);
  const patch = normalizePatch({ payload: { kind: "agentTurn", ...input } });
  expect(patch.payload).toStrictEqual({ kind: "agentTurn", ...expected });
  expect(validateCronUpdateParams({ id: "job-1", patch })).toBe(true);
  if (Array.isArray(input.toolsAllow) && input.toolsAllow.length === 0) {
    const created = createAgent({
      schedule: EVERY_SCHEDULE,
      payload: { ...AGENT_TURN, toolsAllow: [] },
    });
    expect(child(created, "payload").toolsAllow).toStrictEqual([]);
    expect(validateCronAddParams(created)).toBe(true);
  }
});
const payloads = [
  { kind: "agentTurn", message: "Synthetic reminder" },
  { kind: "command", argv: ["printf", "synthetic-proof"] },
  { kind: "script", script: "return { output: 'synthetic-proof' };" },
] satisfies CronPayload[];

it.each(payloads)("sets, preserves, and clears a $kind timeout", (payload) => {
  const existing = { ...payload, timeoutSeconds: 30 };
  for (const timeout of [{}, { timeoutSeconds: 15 }, { timeoutSeconds: null }]) {
    const patch = normalizeCronJobPatch({ payload: { kind: payload.kind, ...timeout } });
    expect(patch?.payload).toEqual({ kind: payload.kind, ...timeout });
    expect(validateCronUpdateParams({ id: "timeout-job", patch })).toBe(true);
    if (!patch?.payload) {
      throw new Error("expected normalized payload patch");
    }
    expect(mergeCronPayload(existing, patch.payload)).toEqual(
      timeout.timeoutSeconds === null ? payload : { ...existing, ...timeout },
    );
  }
});

it.each(payloads)("omits a cleared timeout when replacing the payload with $kind", (payload) => {
  const patch = normalizeCronJobPatch({ payload: { ...payload, timeoutSeconds: null } });
  expect(patch?.payload).toEqual({ ...payload, timeoutSeconds: null });
  if (!patch?.payload) {
    throw new Error("expected normalized payload patch");
  }
  expect(mergeCronPayload({ kind: "systemEvent", text: "before" }, patch.payload)).toEqual(payload);
});
