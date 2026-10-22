// Hook mapping tests protect webhook path matching, templated agent actions,
// transform results, skipped mappings, and file-backed mapping config.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../test/helpers/temp-dir.js";

const hooksTempDirs: string[] = [];
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

afterAll(() => {
  cleanupTempDirs(hooksTempDirs);
});
import {
  applyHookMappings,
  commitHookTransformMappingReload,
  resolveHookMappings,
} from "./hooks-mapping.js";

// Legacy single-action view: these tests protect non-fanout mappings, which
// produce at most one action per request. Fan-out coverage asserts the
// actions[] shape directly.
async function applySingleHookMapping(...args: Parameters<typeof applyHookMappings>) {
  const result = await applyHookMappings(...args);
  if (!result || !result.ok) {
    return result;
  }
  return { ok: true as const, action: result.actions[0] ?? null };
}

const baseUrl = new URL("http://127.0.0.1:18789/hooks/gmail");
type Mapping = NonNullable<
  NonNullable<Parameters<typeof resolveHookMappings>[0]>["mappings"]
>[number];
const agentMapping = (overrides: Partial<Mapping> = {}): Mapping => ({
  match: { path: "gmail" },
  action: "agent",
  messageTemplate: "Subject: {{messages[0].subject}}",
  ...overrides,
});
const mappingContext = (hookPath = "gmail", payload: Record<string, unknown> = {}) => ({
  path: hookPath,
  payload,
  headers: {},
  url: new URL(hookPath, baseUrl),
});
function makeTransforms(prefix: string, perTest = false) {
  const configDir = perTest ? autoCleanupTempDirs.make(prefix) : makeTempDir(hooksTempDirs, prefix);
  const transformsRoot = path.join(configDir, "hooks", "transforms");
  fs.mkdirSync(transformsRoot, { recursive: true });
  return { configDir, transformsRoot };
}
function resolveTransform(
  configDir: string,
  module: string,
  transformsDir?: string,
  matchPath = "custom",
) {
  return resolveHookMappings(
    {
      transformsDir,
      mappings: [
        {
          match: { path: matchPath },
          action: "agent",
          transform: { module },
        },
      ],
    },
    { configDir },
  );
}

describe("hooks mapping", () => {
  const gmailPayload = { messages: [{ subject: "Hello" }] };

  async function applyGmailMappings(config: Parameters<typeof resolveHookMappings>[0]) {
    const mappings = resolveHookMappings(config);
    return applySingleHookMapping(mappings, mappingContext("gmail", gmailPayload));
  }

  function acceptHookMappings(mappings: ReturnType<typeof resolveHookMappings>) {
    commitHookTransformMappingReload();
    return mappings;
  }

  function expectWakeText(
    result: Awaited<ReturnType<typeof applySingleHookMapping>>,
    text: string,
  ) {
    expect(result).toMatchObject({ ok: true, action: { kind: "wake", text } });
  }

  function expectAgentMessage(
    result: Awaited<ReturnType<typeof applySingleHookMapping>> | undefined,
    expectedMessage: string,
  ) {
    expect(result).toMatchObject({ ok: true, action: { kind: "agent", message: expectedMessage } });
  }

  async function applyGmailTransformSessionKey(params: {
    tempPrefix: string;
    transformLines: string[];
    payload?: Record<string, unknown>;
    sessionKey?: string;
  }) {
    const { configDir, transformsRoot } = makeTransforms(params.tempPrefix);
    fs.writeFileSync(path.join(transformsRoot, "transform.mjs"), params.transformLines.join("\n"));

    const mappings = resolveHookMappings(
      {
        mappings: [
          agentMapping({
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            transform: { module: "transform.mjs" },
          }),
        ],
      },
      { configDir },
    );

    return applySingleHookMapping(
      mappings,
      mappingContext("gmail", params.payload ?? gmailPayload),
    );
  }

  function expectAgentSessionKey(
    result: Awaited<ReturnType<typeof applySingleHookMapping>>,
    params: { sessionKey: string; sessionKeySource?: "static" | "templated" },
  ) {
    expect(result).toMatchObject({
      ok: true,
      action: { kind: "agent", ...params, sessionKeySource: params.sessionKeySource },
    });
  }

  it("validates sessionMode returned by hook transforms", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-hook-session-mode-",
      transformLines: ['export default () => ({ sessionMode: "shared" });'],
    });
    expect(result).toEqual({
      ok: false,
      error: "hook mapping sessionMode must be isolated or persistent",
    });
  });

  it("carries wake agent and session routing from mappings", async () => {
    const mappings = resolveHookMappings({
      mappings: [
        {
          id: "targeted-wake",
          match: { path: "gmail" },
          action: "wake",
          textTemplate: "Subject: {{messages[0].subject}}",
          agentId: "hooks",
          sessionKey: "hook:gmail:{{messages[0].subject}}",
        },
      ],
    });
    const result = await applySingleHookMapping(mappings, {
      payload: gmailPayload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "wake") {
      expect(result.action).toMatchObject({
        agentId: "hooks",
        sessionKey: "hook:gmail:Hello",
        sessionKeySource: "templated",
      });
    }
  });

  it.each(["wake", "agent"] as const)(
    "rejects %s session key templates that render empty",
    async (action) => {
      const mappings = resolveHookMappings({
        mappings: [
          {
            id: `empty-${action}-session-key`,
            match: { path: "gmail" },
            action,
            ...(action === "wake"
              ? { textTemplate: "Subject: {{messages[0].subject}}" }
              : { messageTemplate: "Subject: {{messages[0].subject}}" }),
            sessionKey: "{{messages[0].missing}}",
          },
        ],
      });
      const result = await applySingleHookMapping(mappings, mappingContext("gmail", gmailPayload));

      expect(result).toEqual({
        ok: false,
        error: "hook mapping sessionKey template rendered empty",
      });
    },
  );

  it("rejects custom wake sessions that cannot be drained on the next heartbeat", async () => {
    const result = await applyGmailMappings({
      mappings: [
        {
          id: "deferred-targeted-wake",
          match: { path: "gmail" },
          action: "wake",
          textTemplate: "Subject: {{messages[0].subject}}",
          wakeMode: "next-heartbeat",
          sessionKey: "hook:gmail:fixed",
        },
      ],
    });

    expect(result).toEqual({
      ok: false,
      error: "hook mapping sessionKey requires wakeMode=now",
    });
  });

  it.each([
    ["templated by default", "hook:gmail:static", undefined, "hook:gmail:external", "templated"],
    [
      "explicitly static",
      "hook:gmail:{{messages[0].subject}}",
      "static",
      "hook:gmail:fixed",
      "static",
    ],
    ["empty", "hook:gmail:{{messages[0].subject}}", "templated", "", undefined],
  ] as const)(
    "tracks %s transform session keys",
    async (_, sessionKey, source, expected, expectedSource) => {
      const result = await applyGmailTransformSessionKey({
        tempPrefix: "openclaw-config-sessionkey-",
        payload: { subject: "external" },
        sessionKey,
        transformLines: [
          source === undefined ? "export default ({ payload }) => ({" : "export default () => ({",
          '  kind: "agent",',
          '  message: "Transformed",',
          source === undefined
            ? "  sessionKey: `hook:gmail:${payload.subject}`,"
            : `  sessionKey: ${JSON.stringify(expected)},`,
          ...(source === undefined ? [] : [`  sessionKeySource: ${JSON.stringify(source)},`]),
          "});",
        ],
      });
      expectAgentSessionKey(result, { sessionKey: expected, sessionKeySource: expectedSource });
    },
  );

  it("rejects transform module traversal outside transformsDir", () => {
    const { configDir } = makeTransforms("openclaw-config-traversal-");
    expect(() => resolveTransform(configDir, "../evil.mjs")).toThrow(/must be within/);
  });

  it("rejects absolute transform module path outside transformsDir", () => {
    const { configDir } = makeTransforms("openclaw-config-abs-");
    const outside = path.join(os.tmpdir(), "evil.mjs");
    expect(() => resolveTransform(configDir, outside)).toThrow(/must be within/);
  });

  it("rejects transformsDir traversal outside the transforms root", () => {
    const { configDir } = makeTransforms("openclaw-config-xformdir-trav-");
    expect(() => resolveTransform(configDir, "transform.mjs", "..")).toThrow(/Hook transformsDir/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects transform module symlink escape outside transformsDir",
    () => {
      const { configDir, transformsRoot } = makeTransforms("openclaw-config-symlink-module-");
      const outsideDir = makeTempDir(hooksTempDirs, "openclaw-outside-module-");
      const outsideModule = path.join(outsideDir, "evil.mjs");
      fs.writeFileSync(outsideModule, 'export default () => ({ kind: "wake", text: "owned" });');
      fs.symlinkSync(outsideModule, path.join(transformsRoot, "linked.mjs"));
      expect(() => resolveTransform(configDir, "linked.mjs")).toThrow(/must be within/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects transformsDir symlink escape outside transforms root",
    () => {
      const { configDir, transformsRoot } = makeTransforms("openclaw-config-symlink-dir-");
      const outsideDir = makeTempDir(hooksTempDirs, "openclaw-outside-dir-");
      fs.writeFileSync(path.join(outsideDir, "transform.mjs"), "export default () => null;");
      fs.symlinkSync(outsideDir, path.join(transformsRoot, "escape"), "dir");
      expect(() => resolveTransform(configDir, "transform.mjs", "escape")).toThrow(
        /Hook transformsDir/,
      );
    },
  );

  it.runIf(process.platform !== "win32")("accepts in-root transform module symlink", async () => {
    const { configDir, transformsRoot } = makeTransforms("openclaw-config-symlink-ok-");
    const nestedDir = path.join(transformsRoot, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "transform.mjs"), "export default () => null;");
    fs.symlinkSync(path.join(nestedDir, "transform.mjs"), path.join(transformsRoot, "linked.mjs"));

    const mappings = resolveTransform(configDir, "linked.mjs", undefined, "skip");

    const result = await applySingleHookMapping(mappings, mappingContext("skip"));

    expect(result).toEqual({ ok: true, action: null });
  });

  it("prefers explicit mappings over presets", async () => {
    const result = await applyGmailMappings({
      presets: ["gmail"],
      mappings: [
        agentMapping({
          id: "override",
          messageTemplate: "Override subject: {{messages[0].subject}}",
          model: "openai/gpt-4.1-mini",
          agentId: "hooks",
        }),
      ],
    });
    expectAgentMessage(result, "Override subject: Hello");
    expect(result).toMatchObject({
      ok: true,
      action: { mappingId: "override", model: "openai/gpt-4.1-mini", agentId: "hooks" },
    });
  });

  it("uses one transform module instance per mapping reload", async () => {
    const { configDir, transformsRoot } = makeTransforms("openclaw-hooks-generation-", true);
    const modPath = path.join(transformsRoot, "same-generation.mjs");
    fs.writeFileSync(
      modPath,
      [
        "globalThis.__openclawHookTransformInstance = (globalThis.__openclawHookTransformInstance ?? 0) + 1;",
        "const instance = globalThis.__openclawHookTransformInstance;",
        'export function transformA() { return { kind: "wake", text: `A-${instance}` }; }',
        'export function transformB() { return { kind: "wake", text: `B-${instance}` }; }',
      ].join("\n"),
    );

    const mappings = resolveHookMappings(
      {
        mappings: ["A", "B"].map((suffix) =>
          agentMapping({
            match: { path: `test${suffix}` },
            messageTemplate: "unused",
            transform: { module: "same-generation.mjs", export: `transform${suffix}` },
          }),
        ),
      },
      { configDir },
    );

    const instance = async (suffix: string) => {
      const result = await applySingleHookMapping(mappings, mappingContext(`test${suffix}`));
      expect(result?.ok).toBe(true);
      return result?.ok && result.action?.kind === "wake"
        ? result.action.text.match(new RegExp(`^${suffix}-(.+)$`))?.[1]
        : undefined;
    };
    const instanceA = await instance("A");
    expect(instanceA).toBeDefined();
    expect(await instance("B")).toBe(instanceA);
  });

  function resolveReloadableMappings(configDir: string) {
    return resolveHookMappings(
      {
        mappings: [
          agentMapping({
            match: { path: "reloadable" },
            messageTemplate: "unused",
            transform: { module: "reloadable.mjs" },
          }),
        ],
      },
      { configDir },
    );
  }

  function applyReloadableMappings(mappings: ReturnType<typeof resolveHookMappings>) {
    return applySingleHookMapping(mappings, mappingContext("reloadable"));
  }

  it("does not invalidate the active transform cache while resolving a rejected reload", async () => {
    const { configDir, transformsRoot } = makeTransforms("openclaw-hooks-rejected-reload-", true);
    const modPath = path.join(transformsRoot, "reloadable.mjs");
    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "accepted" });');

    const acceptedMappings = acceptHookMappings(resolveReloadableMappings(configDir));
    expectWakeText(await applyReloadableMappings(acceptedMappings), "accepted");

    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "candidate" });');
    const nextTime = new Date(Date.now() + 5_000);
    fs.utimesSync(modPath, nextTime, nextTime);

    const rejectedCandidateMappings = resolveReloadableMappings(configDir);
    expect(rejectedCandidateMappings).toHaveLength(1);

    expectWakeText(await applyReloadableMappings(acceptedMappings), "accepted");

    expectWakeText(
      await applyReloadableMappings(acceptHookMappings(rejectedCandidateMappings)),
      "candidate",
    );
  });

  it("does not let an older in-flight transform import repopulate the reload cache", async ({
    signal,
  }) => {
    const { configDir, transformsRoot } = makeTransforms("openclaw-hooks-overlap-", true);
    const modPath = path.join(transformsRoot, "reloadable.mjs");
    const oldStartedEvent = path.join(configDir, "old-started");
    const oldStarted = createDeferred();
    const releaseOld = createDeferred();
    const onOldStarted = (release: () => void) => {
      oldStarted.resolve();
      void releaseOld.promise.then(release);
    };
    fs.writeFileSync(
      modPath,
      [
        'import process from "node:process";',
        `await new Promise((release) => process.emit(${JSON.stringify(oldStartedEvent)}, release));`,
        'export default () => ({ kind: "wake", text: "old" });',
      ].join("\n"),
    );

    let acceptedMappings = acceptHookMappings(resolveReloadableMappings(configDir));
    process.once(oldStartedEvent, onOldStarted);
    const oldImport = applyReloadableMappings(acceptedMappings);
    try {
      await withinTest(
        awaitGateBeforeSettlement(
          oldStarted.promise,
          oldImport,
          `timed out waiting for ${oldStartedEvent}`,
        ),
        signal,
      );

      fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "new" });');
      const nextTime = new Date(Date.now() + 5_000);
      fs.utimesSync(modPath, nextTime, nextTime);

      acceptedMappings = acceptHookMappings(resolveReloadableMappings(configDir));
      expectWakeText(await withinTest(applyReloadableMappings(acceptedMappings), signal), "new");

      releaseOld.resolve();
      expectWakeText(await withinTest(oldImport, signal), "old");

      expectWakeText(await withinTest(applyReloadableMappings(acceptedMappings), signal), "new");
    } finally {
      releaseOld.resolve();
      try {
        await oldImport;
      } finally {
        process.removeListener(oldStartedEvent, onOldStarted);
      }
    }
  });

  it("rejects missing message", async () => {
    const mappings = resolveHookMappings({
      mappings: [{ match: { path: "noop" }, action: "agent" }],
    });
    const result = await applySingleHookMapping(mappings, mappingContext("noop"));
    expect(result?.ok).toBe(false);
  });

  it("blocks constructor traversal in webhook payload", async () => {
    const mappings = resolveHookMappings({
      mappings: [
        agentMapping({
          id: "constructor-test",
          messageTemplate: "type: {{constructor.name}}",
        }),
      ],
    });
    expectAgentMessage(
      await applySingleHookMapping(
        mappings,
        mappingContext("gmail", { constructor: { name: "INJECTED" } }),
      ),
      "type: ",
    );
  });
});

describe("hook mapping fan-out", () => {
  function applyGmailPreset(payload: Record<string, unknown>) {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    return applyHookMappings(mappings, mappingContext("gmail", payload));
  }

  it("renders one action per batched gmail message with per-message session keys", async () => {
    const result = await applyGmailPreset({
      messages: [
        { id: "m1", from: "a@example.com", subject: "One" },
        { id: "m2", from: "b@example.com", subject: "Two" },
      ],
    });
    expect(result).toMatchObject({
      ok: true,
      fanout: true,
      dropped: 0,
      actions: [
        {
          kind: "agent",
          sessionMode: "isolated",
          sessionKey: "hook:gmail:m1",
          message: expect.stringContaining("a@example.com"),
        },
        {
          kind: "agent",
          sessionMode: "isolated",
          sessionKey: "hook:gmail:m2",
          message: expect.stringContaining("b@example.com"),
        },
      ],
    });
    if (result?.ok) {
      expect(
        result.actions.map((action) => (action.kind === "agent" ? action.message : undefined)),
      ).toEqual([expect.stringContaining("One"), expect.stringContaining("Two")]);
    }
  });

  it("produces no actions for an empty or missing fan-out array", async () => {
    for (const payload of [{ messages: [] }, {}, { messages: "not-an-array" }]) {
      const result = await applyGmailPreset(payload as Record<string, unknown>);
      expect(result).toMatchObject({ ok: true, actions: [], fanout: true, dropped: 0 });
    }
  });

  it("rejects nested forEach paths", () => {
    expect(() =>
      resolveHookMappings({
        mappings: [
          {
            id: "nested",
            match: { path: "gmail" },
            action: "agent",
            forEach: "data.messages",
            messageTemplate: "x",
          },
        ],
      }),
    ).toThrow(/forEach must be a top-level payload key/);
  });
});
