// Cron normalization tests cover job config normalization and defaults.
import { describe, expect, it, vi } from "vitest";
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
const CHANNEL_REQUESTER = {
  version: 1,
  channel: "discord",
  accountId: "work",
  senderId: "123456789012345678",
};
const STALE_AT_SCHEDULE = {
  kind: "at",
  at: "2026-01-12T18:00:00Z",
  expr: "* * * * *",
  everyMs: 60_000,
  anchorMs: 123,
  tz: "UTC",
  staggerMs: 30_000,
};
const NORMALIZED_AT_SCHEDULE = {
  kind: "at",
  at: new Date("2026-01-12T18:00:00Z").toISOString(),
};
const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function normalizeCreate(raw: UnknownRecord, sessionKey?: string): UnknownRecord {
  return normalizeCronJobCreate(
    raw,
    sessionKey ? { sessionContext: { sessionKey } } : undefined,
  ) as unknown as UnknownRecord;
}

function createMain(overrides: UnknownRecord = {}): UnknownRecord {
  return normalizeCreate({
    name: "test",
    enabled: true,
    schedule: CRON_SCHEDULE,
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: SYSTEM_EVENT,
    ...overrides,
  });
}

function createAgent(overrides: UnknownRecord = {}, sessionKey?: string): UnknownRecord {
  return normalizeCreate(
    {
      name: "test",
      enabled: true,
      schedule: CRON_SCHEDULE,
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: AGENT_TURN,
      ...overrides,
    },
    sessionKey,
  );
}

function createDefaulted(payload: UnknownRecord, overrides: UnknownRecord = {}): UnknownRecord {
  return normalizeCreate({ name: "test", schedule: EVERY_SCHEDULE, payload, ...overrides });
}

function normalizePatch(raw: UnknownRecord): UnknownRecord {
  return normalizeCronJobPatch(raw) as unknown as UnknownRecord;
}

function child(record: UnknownRecord, key: string): UnknownRecord {
  return record[key] as UnknownRecord;
}

function mainSchedule(schedule: UnknownRecord): UnknownRecord {
  return child(createMain({ schedule }), "schedule");
}

function agentDelivery(delivery: UnknownRecord): UnknownRecord {
  return child(createAgent({ delivery }), "delivery");
}

describe("normalizeCronJobCreate", () => {
  it.each(["create", "patch"] as const)(
    "does not validate absent delivery fields during %s normalization",
    (mode) => {
      const parsers = [
        vi.spyOn(LowercaseNonEmptyStringFieldSchema, "safeParse"),
        vi.spyOn(TrimmedNonEmptyStringFieldSchema, "safeParse"),
        vi.spyOn(DeliveryThreadIdFieldSchema, "safeParse"),
      ];
      try {
        for (const delivery of [
          { mode: "none" },
          {
            mode: "none",
            channel: undefined,
            to: undefined,
            threadId: undefined,
            accountId: undefined,
          },
        ]) {
          const normalized =
            mode === "create" ? createAgent({ delivery }) : normalizePatch({ delivery });
          expect(normalized.delivery).toEqual({ mode: "none" });
        }
        for (const parser of parsers) {
          expect(parser).not.toHaveBeenCalled();
        }
      } finally {
        for (const parser of parsers) {
          parser.mockRestore();
        }
      }
    },
  );

  describe.each(["create", "patch"] as const)("%s authority envelopes", (mode) => {
    const normalize = mode === "create" ? normalizeCreate : normalizePatch;
    const envelopes = {
      scheduledToolPolicy: { version: 1, mode: "trusted" },
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "local" },
        channelRequester: CHANNEL_REQUESTER,
      },
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
        {
          scheduledToolPolicy: undefined,
          toolsAllowProvenance: undefined,
          toolsAllowExecTarget: undefined,
          toolsAllowExecTargetRequirement: undefined,
          runtimeAuthority: undefined,
        },
        Object.create(envelopes) as UnknownRecord,
      ]) {
        const normalized = normalize(input);

        expect(normalized).not.toHaveProperty("scheduledToolPolicy");
        expect(normalized).not.toHaveProperty("toolsAllowProvenance");
        expect(normalized).not.toHaveProperty("toolsAllowExecTarget");
        expect(normalized).not.toHaveProperty("toolsAllowExecTargetRequirement");
        expect(normalized).not.toHaveProperty("runtimeAuthority");
      }
    });

    it("retains valid envelopes without mutating or freezing the input", () => {
      const input = structuredClone(envelopes);

      const normalized = normalize(input);

      expect(normalized).toMatchObject(envelopes);
      expect(input).toEqual(envelopes);
      const authority = child(normalized, "runtimeAuthority");
      const payload = child(authority, "payload");
      expect(authority).not.toBe(input.runtimeAuthority);
      expect(payload).not.toBe(input.runtimeAuthority.payload);
      expect(Object.isFrozen(authority)).toBe(true);
      expect(Object.isFrozen(payload)).toBe(true);
      expect(Object.isFrozen((payload.tools as unknown[])[0])).toBe(true);
      expect(Object.isFrozen(input.runtimeAuthority)).toBe(false);
      expect(Object.isFrozen(input.runtimeAuthority.payload)).toBe(false);
      expect(Object.isFrozen(input.runtimeAuthority.payload.tools[0])).toBe(false);
    });

    it("retains a recovery marker while dropping invalid peer envelopes", () => {
      const normalized = normalize({
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
  });

  it.each(["create", "patch"] as const)(
    "does not promote prototype-only schedule fields during %s normalization",
    (mode) => {
      const schedule = Object.assign(Object.create({ expr: "*/17 * * * *" }) as UnknownRecord, {
        kind: "cron",
      });
      const normalized =
        mode === "create" ? createMain({ schedule }) : normalizePatch({ schedule });

      expect(Object.hasOwn(schedule, "expr")).toBe(false);
      expect(Object.hasOwn(child(normalized, "schedule"), "expr")).toBe(false);
    },
  );
  it("does not promote prototype-only payload fields", () => {
    const payload = Object.assign(
      Object.create({ model: "openai/gpt-5" }) as UnknownRecord,
      AGENT_TURN,
    );

    expect(child(createAgent({ payload }), "payload")).not.toHaveProperty("model");
  });
  it("retains only authored native requester and caller facts without claiming a captured tool surface", () => {
    const ignoredGetter = vi.fn(() => true);
    const channelRequester = Object.defineProperty(
      {
        ...CHANNEL_REQUESTER,
        channel: " Discord ",
        accountId: " Work ",
        senderId: " 123456789012345678 ",
        roles: ["administrator"],
      },
      "senderIsOwner",
      { enumerable: true, get: ignoredGetter },
    );
    const normalized = createAgent({
      toolsAllowProvenance: {
        version: 1,
        source: "authenticated-requester",
        callerOrigin: { kind: "local" },
        channelRequester,
      },
    });

    expect(normalized.toolsAllowProvenance).toEqual({
      version: 1,
      source: "authenticated-requester",
      callerOrigin: { kind: "local" },
      channelRequester: CHANNEL_REQUESTER,
    });
    expect(ignoredGetter).not.toHaveBeenCalled();
  });
  it.each([
    { label: "unknown version", patch: { version: 2 } },
    { label: "blank channel", patch: { channel: " " } },
    { label: "invalid account", patch: { accountId: "__proto__" } },
    { label: "non-string sender", patch: { senderId: 123 } },
  ])("drops $label requester facts without losing genuine tool-surface proof", ({ patch }) => {
    const normalized = createAgent({
      toolsAllowProvenance: {
        version: 1,
        source: "final-executable-surface",
        callerOrigin: { kind: "local" },
        channelRequester: { ...CHANNEL_REQUESTER, ...patch },
      },
    });

    expect(normalized.toolsAllowProvenance).toEqual({
      version: 1,
      source: "final-executable-surface",
      callerOrigin: { kind: "local" },
    });
  });
  it("rejects accessor and inherited requester identities without invoking getters", () => {
    const senderGetter = vi.fn(() => CHANNEL_REQUESTER.senderId);
    const accessorRequester = Object.defineProperty({ ...CHANNEL_REQUESTER }, "senderId", {
      enumerable: true,
      get: senderGetter,
    });
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
  it.each<{
    label: string;
    input: UnknownRecord;
    expected: UnknownRecord;
  }>([
    {
      label: "trimmed timezone",
      input: { ...CRON_SCHEDULE, tz: " Europe/Vienna " },
      expected: { ...CRON_SCHEDULE, tz: "Europe/Vienna" },
    },
    { label: "blank timezone", input: { ...CRON_SCHEDULE, tz: " " }, expected: CRON_SCHEDULE },
    {
      label: "one-shot",
      input: { ...STALE_AT_SCHEDULE, at: "2026-01-12T18:00:00" },
      expected: NORMALIZED_AT_SCHEDULE,
    },
    {
      label: "interval",
      input: {
        kind: "every",
        everyMs: "60000",
        anchorMs: "123.9",
        staggerMs: "abc",
        command: "leftover",
        cwd: "/x",
      },
      expected: { ...EVERY_SCHEDULE, anchorMs: 123 },
    },
    {
      label: "on-exit",
      input: {
        kind: "on-exit",
        command: "make build",
        cwd: "/repo",
        everyMs: 1000,
        expr: "* * * * *",
        at: "2026-01-01T00:00:00Z",
      },
      expected: { kind: "on-exit", command: "make build", cwd: "/repo" },
    },
    {
      label: "on-exit escaped trailing space",
      input: { kind: "on-exit", command: " printf %s hello\\ ", cwd: "/repo" },
      expected: { kind: "on-exit", command: " printf %s hello\\ ", cwd: "/repo" },
    },
  ])("canonicalizes $label schedules on create and patch", ({ input, expected }) => {
    const created = createMain({ schedule: input });
    const patch = normalizePatch({ schedule: input });
    expect(created.schedule).toEqual(expected);
    expect(patch.schedule).toEqual(expected);
    expect(validateCronAddParams(created)).toBe(true);
    expect(validateCronUpdateParams({ id: "job", patch })).toBe(true);
    if (input.kind === "at") {
      expect(created.deleteAfterRun).toBe(true);
    }
  });

  it.each([
    { input: {}, created: DEFAULT_TOP_OF_HOUR_STAGGER_MS, patched: undefined },
    { input: { staggerMs: 0 }, created: 0, patched: 0 },
    { input: { staggerMs: "30000" }, created: 30_000, patched: 30_000 },
  ])("defaults only omitted create stagger: $input", ({ input, created, patched }) => {
    const schedule = { kind: "cron", expr: "0 * * * *", tz: "UTC", ...input };
    expect(mainSchedule(schedule).staggerMs).toBe(created);
    expect(child(normalizePatch({ schedule }), "schedule").staggerMs).toBe(patched);
  });

  it.each(["1e3", "42.8", "0x10", "abc", "", null, {}, 8_640_000_000_000_001])(
    "rejects invalid explicit cron stagger %j before create or patch defaults",
    (staggerMs) => {
      const schedule = { kind: "cron", expr: "0 * * * *", staggerMs };
      expect(() => createMain({ schedule })).toThrow(/staggerMs/);
      expect(() => normalizePatch({ schedule })).toThrow(/staggerMs/);
    },
  );

  it("keeps invalid every schedule numbers invalid for validation", () => {
    expect(validateCronAddParams(createMain({ schedule: { kind: "every", everyMs: "0" } }))).toBe(
      false,
    );
    const patch = normalizePatch({ schedule: { kind: "every", everyMs: "60000", anchorMs: "-1" } });
    expect(validateCronUpdateParams({ id: "job", patch })).toBe(false);
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
    [{ agentId: null }, { agentId: null }],
    [
      { sessionKey: " agent:main:telegram:group:-100123 " },
      { sessionKey: "agent:main:telegram:group:-100123" },
    ],
    [{ sessionKey: " " }, {}],
    [{ sessionKey: null }, { sessionKey: null }],
    [
      { sessionTarget: " IsOlAtEd ", wakeMode: " NOW " },
      { sessionTarget: "isolated", wakeMode: "now" },
    ],
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

  it.each([
    {
      input: " Current ",
      context: " agent:main:telegram:direct:42 ",
      target: "current",
      sessionKey: "agent:main:telegram:direct:42",
    },
    { input: "current", context: undefined, target: "isolated", sessionKey: undefined },
    {
      input: "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
      context: undefined,
      target: "session:agent:main:dingtalk:group:cid3tmd4xb19xjfk/wogxwy2a==",
      sessionKey: undefined,
    },
  ])("resolves session target $input", ({ input, context, target, sessionKey }) => {
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

  it.each<[UnknownRecord, UnknownRecord]>([
    [
      {
        mode: " ANNOUNCE ",
        channel: " TeLeGrAm ",
        to: " 7200373102 ",
        accountId: " coordinator ",
        threadId: " 1008013 ",
      },
      {
        mode: "announce",
        channel: "telegram",
        to: "7200373102",
        accountId: "coordinator",
        threadId: "1008013",
      },
    ],
    [
      { mode: "announce", channel: "telegram", accountId: " ", threadId: 1008013 },
      { mode: "announce", channel: "telegram", threadId: 1008013 },
    ],
    [
      { mode: " WeBhOoK ", to: " https://example.invalid/cron " },
      { mode: "webhook", to: "https://example.invalid/cron" },
    ],
  ])("normalizes delivery fields %j", (input, expected) => {
    expect(agentDelivery(input)).toEqual(expected);
  });

  it.each<unknown>(["bogus", null, undefined])(
    "leaves invalid delivery mode %s for validation",
    (mode) => {
      const delivery = { ...(mode === undefined ? {} : { mode }), channel: "telegram", to: "123" };
      const created = createAgent({ schedule: EVERY_SCHEDULE, delivery });
      const patch = normalizePatch({ delivery });
      expect(created.delivery).toEqual(delivery);
      expect(patch.delivery).toEqual(delivery);
      expect(validateCronAddParams(created)).toBe(false);
      expect(validateCronUpdateParams({ id: "job", patch })).toBe(mode === undefined);
    },
  );

  it("normalizes completion destinations without inventing an enclosing mode", () => {
    const delivery = {
      completionDestination: { mode: " WeBhOoK ", to: " https://example.invalid/complete " },
    };
    const expected = {
      completionDestination: { mode: "webhook", to: "https://example.invalid/complete" },
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

  it("normalizes whitespace-only payload text to empty strings so validation rejects it", () => {
    const agentTurn = createAgent({
      schedule: EVERY_SCHEDULE,
      payload: { kind: "agentTurn", message: "   " },
    });
    const systemEvent = createMain({
      schedule: EVERY_SCHEDULE,
      wakeMode: "now",
      payload: { kind: "systemEvent", text: "   " },
    });
    const patch = normalizePatch({ payload: { kind: "agentTurn", message: "   " } });
    expect(agentTurn.payload).toEqual({ kind: "agentTurn", message: "" });
    expect(systemEvent.payload).toEqual({ kind: "systemEvent", text: "" });
    expect(patch.payload).toEqual({ kind: "agentTurn", message: "" });
    expect(validateCronAddParams(agentTurn)).toBe(false);
    expect(validateCronAddParams(systemEvent)).toBe(false);
    expect(validateCronUpdateParams({ id: "job", patch })).toBe(false);
  });

  it("defaults command jobs while retaining argv bytes and normalizing execution options", () => {
    const normalized = createDefaulted({
      kind: "command",
      argv: ["printf", "%s", "  padded value  "],
      cwd: " /srv/example ",
      env: { FOO: "bar" },
      timeoutSeconds: 30,
      noOutputTimeoutSeconds: 5,
      outputMaxBytes: 4096,
    });
    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.delivery).toEqual({ mode: "announce" });
    expect(normalized.payload).toEqual({
      kind: "command",
      argv: ["printf", "%s", "  padded value  "],
      cwd: "/srv/example",
      env: { FOO: "bar" },
      timeoutSeconds: 30,
      noOutputTimeoutSeconds: 5,
      outputMaxBytes: 4096,
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it.each([0, 0.03, -5])(
    "normalizes agentTurn timeout %s without inventing no-timeout",
    (timeoutSeconds) => {
      const normalized = createDefaulted({ ...AGENT_TURN, timeoutSeconds });
      if (timeoutSeconds < 0) {
        expect(normalized.payload).not.toHaveProperty("timeoutSeconds");
        expect(createDefaulted(AGENT_TURN, { timeoutSeconds }).payload).not.toHaveProperty(
          "timeoutSeconds",
        );
      } else {
        expect(child(normalized, "payload").timeoutSeconds).toBe(timeoutSeconds);
      }
    },
  );

  it("promotes implicit text payloads with agentTurn hints to agentTurn create jobs", () => {
    const normalized = createDefaulted({
      text: " summarize the build ",
      model: " openai/gpt-5 ",
      fallbacks: [" anthropic/claude-haiku-3-5 "],
      thinking: " high ",
      timeoutSeconds: 45,
      lightContext: true,
      skipIfScratchEmpty: true,
      includeReasoning: false,
      toolsAllow: [" read "],
      allowUnsafeExternalContent: true,
    });
    expect(normalized.sessionTarget).toBe("isolated");
    expect(normalized.delivery).toEqual({ mode: "announce" });
    expect(normalized.payload).toEqual({
      kind: "agentTurn",
      message: "summarize the build",
      model: "openai/gpt-5",
      fallbacks: ["anthropic/claude-haiku-3-5"],
      thinking: "high",
      timeoutSeconds: 45,
      lightContext: true,
      skipIfScratchEmpty: true,
      includeReasoning: false,
      toolsAllow: ["read"],
      allowUnsafeExternalContent: true,
    });
    expect(validateCronAddParams(normalized)).toBe(true);
  });

  it("retains shared tool restrictions while stripping agent fields from system events", () => {
    const payload = {
      kind: "systemEvent",
      text: "hello",
      model: "openai/gpt-5",
      fallbacks: ["openai/gpt-4.1-mini"],
      thinking: "high",
      timeoutSeconds: 45,
      lightContext: true,
      skipIfScratchEmpty: true,
      includeReasoning: false,
      toolsAllow: ["exec"],
      allowUnsafeExternalContent: true,
    };
    const created = createMain({ schedule: EVERY_SCHEDULE, wakeMode: "now", payload });
    const patch = normalizePatch({ payload });
    expect(created.payload).toEqual({ kind: "systemEvent", text: "hello", toolsAllow: ["exec"] });
    expect(patch.payload).toEqual({ kind: "systemEvent", text: "hello", toolsAllow: ["exec"] });
    expect(validateCronAddParams(created)).toBe(true);
    expect(validateCronUpdateParams({ id: "job", patch })).toBe(true);
  });
});

describe("normalizeCronJobPatch", () => {
  it.each<[UnknownRecord, UnknownRecord]>([
    [
      { message: " \tCheck the inbox.\r\n  NO_REPLY when quiet.\n ", text: " text " },
      { message: " \tCheck the inbox.\r\n  NO_REPLY when quiet.\n ", text: "text" },
    ],
    [
      { message: 7, text: null, model: {}, thinking: false, fallbacks: [7], toolsAllow: "read" },
      { message: 7, text: null },
    ],
    [
      {
        model: " model-a ",
        thinking: " high ",
        fallbacks: [" model-b ", "", 7, "model-b"],
        toolsAllow: [" read ", false, " exec "],
      },
      {
        model: "model-a",
        thinking: "high",
        fallbacks: ["model-b", "model-b"],
        toolsAllow: ["read", "exec"],
      },
    ],
    [
      { outputMaxBytes: 2.9, toolBudget: 0.5, timeoutSeconds: 0, noOutputTimeoutSeconds: 0.5 },
      { outputMaxBytes: 2, toolBudget: 0, timeoutSeconds: 0, noOutputTimeoutSeconds: 0.5 },
    ],
    [{ outputMaxBytes: "2", toolBudget: "3" }, {}],
    [{ outputMaxBytes: 0, toolBudget: -1 }, {}],
    [{ text: " report ", model: " ", thinking: " " }, { text: "report" }],
    [
      { text: " report ", thinking: null },
      { kind: "agentTurn", message: "report", thinking: null },
    ],
  ])("normalizes partial payload %j", (input, expected) => {
    expect(normalizePatch({ payload: input }).payload).toStrictEqual(expected);
  });

  it.each<[UnknownRecord, UnknownRecord]>([
    [
      { model: null, thinking: null, fallbacks: null, toolsAllow: null },
      { model: null, thinking: null, fallbacks: null, toolsAllow: null },
    ],
    [
      { fallbacks: [], toolsAllow: [] },
      { fallbacks: [], toolsAllow: [] },
    ],
    [
      {
        fallbacks: [" openrouter/gpt-4.1-mini ", "anthropic/claude-haiku-3-5"],
        toolsAllow: [" exec ", " read "],
      },
      {
        fallbacks: ["openrouter/gpt-4.1-mini", "anthropic/claude-haiku-3-5"],
        toolsAllow: ["exec", "read"],
      },
    ],
    [{ fallbacks: [123], toolsAllow: [123] }, {}],
  ])("normalizes explicit agentTurn overrides %j", (input, expected) => {
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

  it("does not infer agentTurn from the shared toolsAllow field", () => {
    const patch = normalizePatch({
      payload: { text: " continue the report ", toolsAllow: [" read "] },
    });
    expect(patch.payload).toEqual({ text: "continue the report", toolsAllow: ["read"] });
    expect(validateCronUpdateParams({ id: "job-1", patch })).toBe(false);
  });
});

describe("cron timeout update lifecycle", () => {
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
    expect(mergeCronPayload({ kind: "systemEvent", text: "before" }, patch.payload)).toEqual(
      payload,
    );
  });
});
