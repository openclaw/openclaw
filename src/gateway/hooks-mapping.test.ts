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

describe("hooks mapping", () => {
  const gmailPayload = { messages: [{ subject: "Hello" }] };

  function expectSkippedTransformResult(
    result: Awaited<ReturnType<typeof applySingleHookMapping>>,
  ) {
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action).toBeNull();
    }
  }

  function createGmailAgentMapping(params: {
    id: string;
    messageTemplate: string;
    model?: string;
    agentId?: string;
  }) {
    return {
      id: params.id,
      match: { path: "gmail" },
      action: "agent" as const,
      messageTemplate: params.messageTemplate,
      ...(params.model ? { model: params.model } : {}),
      ...(params.agentId ? { agentId: params.agentId } : {}),
    };
  }

  async function applyGmailMappings(config: Parameters<typeof resolveHookMappings>[0]) {
    const mappings = resolveHookMappings(config);
    return applySingleHookMapping(mappings, {
      payload: gmailPayload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
  }

  function acceptHookMappings(mappings: ReturnType<typeof resolveHookMappings>) {
    commitHookTransformMappingReload();
    return mappings;
  }

  function expectAgentMessage(
    result: Awaited<ReturnType<typeof applySingleHookMapping>> | undefined,
    expectedMessage: string,
  ) {
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.kind).toBe("agent");
      expect(result.action.message).toBe(expectedMessage);
    }
  }

  async function expectBlockedPrototypeTraversal(params: {
    id: string;
    messageTemplate: string;
    payload: Record<string, unknown>;
    expectedMessage: string;
  }) {
    const mappings = resolveHookMappings({
      mappings: [
        createGmailAgentMapping({
          id: params.id,
          messageTemplate: params.messageTemplate,
        }),
      ],
    });
    const result = await applySingleHookMapping(mappings, {
      payload: params.payload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
    expectAgentMessage(result, params.expectedMessage);
  }

  async function applyGmailTransformSessionKey(params: {
    tempPrefix: string;
    transformLines: string[];
    payload?: Record<string, unknown>;
    sessionKey?: string;
  }) {
    const configDir = makeTempDir(hooksTempDirs, params.tempPrefix);
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    fs.writeFileSync(path.join(transformsRoot, "transform.mjs"), params.transformLines.join("\n"));

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir },
    );

    return applySingleHookMapping(mappings, {
      payload: params.payload ?? gmailPayload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
  }

  function expectAgentSessionKey(
    result: Awaited<ReturnType<typeof applySingleHookMapping>>,
    params: { sessionKey: string; sessionKeySource?: "static" | "templated" },
  ) {
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.sessionKey).toBe(params.sessionKey);
      expect(result.action.sessionKeySource).toBe(params.sessionKeySource);
    }
  }

  it("defaults agent mappings to isolated sessions and accepts persistent overrides", async () => {
    const isolated = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "isolated",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expect(isolated?.ok).toBe(true);
    if (isolated?.ok && isolated.action?.kind === "agent") {
      expect(isolated.action.sessionMode).toBe("isolated");
    }

    const persistent = await applyGmailMappings({
      mappings: [
        {
          ...createGmailAgentMapping({
            id: "persistent",
            messageTemplate: "Subject: {{messages[0].subject}}",
          }),
          sessionMode: "persistent",
        },
      ],
    });
    expect(persistent?.ok).toBe(true);
    if (persistent?.ok && persistent.action?.kind === "agent") {
      expect(persistent.action.sessionMode).toBe("persistent");
    }
  });

  it("validates sessionMode returned by hook transforms", async () => {
    const configDir = makeTempDir(hooksTempDirs, "openclaw-hook-session-mode-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    fs.writeFileSync(
      path.join(transformsRoot, "transform.mjs"),
      'export default () => ({ sessionMode: "shared" });',
    );
    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "gmail" },
            action: "agent",
            messageTemplate: "Subject: {{messages[0].subject}}",
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir },
    );

    const result = await applySingleHookMapping(mappings, {
      payload: gmailPayload,
      headers: {},
      url: baseUrl,
      path: "gmail",
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
      const result = await applySingleHookMapping(mappings, {
        payload: gmailPayload,
        headers: {},
        url: baseUrl,
        path: "gmail",
      });

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

  it("treats transform-provided session keys as templated by default", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-config-sessionkey-xform-",
      payload: { subject: "external" },
      sessionKey: "hook:gmail:static",
      transformLines: [
        "export default ({ payload }) => ({",
        '  kind: "agent",',
        '  message: "Transformed",',
        "  sessionKey: `hook:gmail:${payload.subject}`,",
        "});",
      ],
    });

    expectAgentSessionKey(result, {
      sessionKey: "hook:gmail:external",
      sessionKeySource: "templated",
    });
  });

  it("uses transform-provided static session key source metadata", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-config-sessionkey-static-",
      sessionKey: "hook:gmail:{{messages[0].subject}}",
      transformLines: [
        "export default () => ({",
        '  kind: "agent",',
        '  message: "Transformed",',
        '  sessionKey: "hook:gmail:fixed",',
        '  sessionKeySource: "static",',
        "});",
      ],
    });

    expectAgentSessionKey(result, { sessionKey: "hook:gmail:fixed", sessionKeySource: "static" });
  });

  it("treats empty transform session keys as absent for source tracking", async () => {
    const result = await applyGmailTransformSessionKey({
      tempPrefix: "openclaw-config-sessionkey-empty-",
      sessionKey: "hook:gmail:{{messages[0].subject}}",
      transformLines: [
        "export default () => ({",
        '  kind: "agent",',
        '  message: "Transformed",',
        '  sessionKey: "",',
        '  sessionKeySource: "templated",',
        "});",
      ],
    });

    expectAgentSessionKey(result, { sessionKey: "" });
  });

  it("rejects transform module traversal outside transformsDir", () => {
    const configDir = makeTempDir(hooksTempDirs, "openclaw-config-traversal-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "../evil.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/must be within/);
  });

  it("rejects absolute transform module path outside transformsDir", () => {
    const configDir = makeTempDir(hooksTempDirs, "openclaw-config-abs-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const outside = path.join(os.tmpdir(), "evil.mjs");
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: outside },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/must be within/);
  });

  it("rejects transformsDir traversal outside the transforms root", () => {
    const configDir = makeTempDir(hooksTempDirs, "openclaw-config-xformdir-trav-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          transformsDir: "..",
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "transform.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/Hook transformsDir/);
  });

  it.runIf(process.platform !== "win32")(
    "rejects transform module symlink escape outside transformsDir",
    () => {
      const configDir = makeTempDir(hooksTempDirs, "openclaw-config-symlink-module-");
      const transformsRoot = path.join(configDir, "hooks", "transforms");
      fs.mkdirSync(transformsRoot, { recursive: true });
      const outsideDir = makeTempDir(hooksTempDirs, "openclaw-outside-module-");
      const outsideModule = path.join(outsideDir, "evil.mjs");
      fs.writeFileSync(outsideModule, 'export default () => ({ kind: "wake", text: "owned" });');
      fs.symlinkSync(outsideModule, path.join(transformsRoot, "linked.mjs"));
      expect(() =>
        resolveHookMappings(
          {
            mappings: [
              {
                match: { path: "custom" },
                action: "agent",
                transform: { module: "linked.mjs" },
              },
            ],
          },
          { configDir },
        ),
      ).toThrow(/must be within/);
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects transformsDir symlink escape outside transforms root",
    () => {
      const configDir = makeTempDir(hooksTempDirs, "openclaw-config-symlink-dir-");
      const transformsRoot = path.join(configDir, "hooks", "transforms");
      fs.mkdirSync(transformsRoot, { recursive: true });
      const outsideDir = makeTempDir(hooksTempDirs, "openclaw-outside-dir-");
      fs.writeFileSync(path.join(outsideDir, "transform.mjs"), "export default () => null;");
      fs.symlinkSync(outsideDir, path.join(transformsRoot, "escape"), "dir");
      expect(() =>
        resolveHookMappings(
          {
            transformsDir: "escape",
            mappings: [
              {
                match: { path: "custom" },
                action: "agent",
                transform: { module: "transform.mjs" },
              },
            ],
          },
          { configDir },
        ),
      ).toThrow(/Hook transformsDir/);
    },
  );

  it.runIf(process.platform !== "win32")("accepts in-root transform module symlink", async () => {
    const configDir = makeTempDir(hooksTempDirs, "openclaw-config-symlink-ok-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    const nestedDir = path.join(transformsRoot, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(path.join(nestedDir, "transform.mjs"), "export default () => null;");
    fs.symlinkSync(path.join(nestedDir, "transform.mjs"), path.join(transformsRoot, "linked.mjs"));

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "skip" },
            action: "agent",
            transform: { module: "linked.mjs" },
          },
        ],
      },
      { configDir },
    );

    const result = await applySingleHookMapping(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/skip"),
      path: "skip",
    });

    expectSkippedTransformResult(result);
  });

  it("prefers explicit mappings over presets", async () => {
    const result = await applyGmailMappings({
      presets: ["gmail"],
      mappings: [
        createGmailAgentMapping({
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
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-generation-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
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
        mappings: [
          {
            match: { path: "testA" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "same-generation.mjs", export: "transformA" },
          },
          {
            match: { path: "testB" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "same-generation.mjs", export: "transformB" },
          },
        ],
      },
      { configDir },
    );

    const resultA = await applySingleHookMapping(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/testA"),
      path: "testA",
    });
    const resultB = await applySingleHookMapping(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/testB"),
      path: "testB",
    });

    expect(resultA?.ok).toBe(true);
    expect(resultB?.ok).toBe(true);
    let instanceA: string | undefined;
    let instanceB: string | undefined;
    if (resultA?.ok && resultA.action?.kind === "wake") {
      instanceA = resultA.action.text.match(/^A-(.+)$/)?.[1];
    }
    if (resultB?.ok && resultB.action?.kind === "wake") {
      instanceB = resultB.action.text.match(/^B-(.+)$/)?.[1];
    }
    expect(instanceA).toBeDefined();
    expect(instanceB).toBe(instanceA);
  });

  function resolveReloadableMappings(configDir: string) {
    return resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "reloadable" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "reloadable.mjs" },
          },
        ],
      },
      { configDir },
    );
  }

  function applyReloadableMappings(mappings: ReturnType<typeof resolveHookMappings>) {
    return applySingleHookMapping(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/reloadable"),
      path: "reloadable",
    });
  }

  it("does not invalidate the active transform cache while resolving a rejected reload", async () => {
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-rejected-reload-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "reloadable.mjs");
    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "accepted" });');

    const acceptedMappings = acceptHookMappings(resolveReloadableMappings(configDir));
    const accepted = await applyReloadableMappings(acceptedMappings);
    expect(accepted?.ok).toBe(true);
    if (accepted?.ok && accepted.action?.kind === "wake") {
      expect(accepted.action.text).toBe("accepted");
    }

    fs.writeFileSync(modPath, 'export default () => ({ kind: "wake", text: "candidate" });');
    const nextTime = new Date(Date.now() + 5_000);
    fs.utimesSync(modPath, nextTime, nextTime);

    const rejectedCandidateMappings = resolveReloadableMappings(configDir);
    expect(rejectedCandidateMappings).toHaveLength(1);

    const stillAccepted = await applyReloadableMappings(acceptedMappings);
    expect(stillAccepted?.ok).toBe(true);
    if (stillAccepted?.ok && stillAccepted.action?.kind === "wake") {
      expect(stillAccepted.action.text).toBe("accepted");
    }

    const newlyAccepted = await applyReloadableMappings(
      acceptHookMappings(rejectedCandidateMappings),
    );
    expect(newlyAccepted?.ok).toBe(true);
    if (newlyAccepted?.ok && newlyAccepted.action?.kind === "wake") {
      expect(newlyAccepted.action.text).toBe("candidate");
    }
  });

  it("does not let an older in-flight transform import repopulate the reload cache", async ({
    signal,
  }) => {
    const configDir = autoCleanupTempDirs.make("openclaw-hooks-overlap-");
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
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
      const afterReload = await withinTest(applyReloadableMappings(acceptedMappings), signal);
      expect(afterReload?.ok).toBe(true);
      if (afterReload?.ok && afterReload.action?.kind === "wake") {
        expect(afterReload.action.text).toBe("new");
      }

      releaseOld.resolve();
      const olderResult = await withinTest(oldImport, signal);
      expect(olderResult?.ok).toBe(true);
      if (olderResult?.ok && olderResult.action?.kind === "wake") {
        expect(olderResult.action.text).toBe("old");
      }

      const final = await withinTest(applyReloadableMappings(acceptedMappings), signal);
      expect(final?.ok).toBe(true);
      if (final?.ok && final.action?.kind === "wake") {
        expect(final.action.text).toBe("new");
      }
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
    const result = await applySingleHookMapping(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/noop"),
      path: "noop",
    });
    expect(result?.ok).toBe(false);
  });

  describe("prototype pollution protection", () => {
    it("blocks constructor traversal in webhook payload", async () => {
      await expectBlockedPrototypeTraversal({
        id: "constructor-test",
        messageTemplate: "type: {{constructor.name}}",
        payload: { constructor: { name: "INJECTED" } } as Record<string, unknown>,
        expectedMessage: "type: ",
      });
    });
  });
});

describe("hook mapping fan-out", () => {
  const fanOutUrl = new URL("http://127.0.0.1:18789/hooks/gmail");

  function applyGmailPreset(payload: Record<string, unknown>) {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    return applyHookMappings(mappings, { payload, headers: {}, url: fanOutUrl, path: "gmail" });
  }

  it("renders one action per batched gmail message with per-message session keys", async () => {
    const result = await applyGmailPreset({
      messages: [
        { id: "m1", from: "a@example.com", subject: "One" },
        { id: "m2", from: "b@example.com", subject: "Two" },
      ],
    });
    expect(result?.ok).toBe(true);
    if (!result?.ok) {
      return;
    }
    expect(result.fanout).toBe(true);
    expect(result.dropped).toBe(0);
    expect(result.actions).toHaveLength(2);
    const agentActions = result.actions.filter((action) => action.kind === "agent");
    expect(agentActions.map((action) => action.sessionKey)).toEqual([
      "hook:gmail:m1",
      "hook:gmail:m2",
    ]);
    expect(agentActions[0]?.message).toContain("a@example.com");
    expect(agentActions[0]?.message).toContain("One");
    expect(agentActions[1]?.message).toContain("b@example.com");
    expect(agentActions[1]?.message).toContain("Two");
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
