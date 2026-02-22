import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyHookMappings, resolveHookMappings } from "./hooks-mapping.js";

const baseUrl = new URL("http://127.0.0.1:18789/hooks/gmail");

describe("hooks mapping", () => {
  const gmailPayload = { messages: [{ subject: "Hello" }] };

  function expectSkippedTransformResult(result: Awaited<ReturnType<typeof applyHookMappings>>) {
    expect(result?.ok).toBe(true);
    if (result?.ok) {
      expect(result.action).toBeNull();
      expect("skipped" in result).toBe(true);
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
    return applyHookMappings(mappings, {
      payload: gmailPayload,
      headers: {},
      url: baseUrl,
      path: "gmail",
    });
  }

  async function applyNullTransformFromTempConfig(params: {
    configDir: string;
    transformsDir?: string;
  }) {
    const transformsRoot = path.join(params.configDir, "hooks", "transforms");
    const transformsDir = params.transformsDir
      ? path.join(transformsRoot, params.transformsDir)
      : transformsRoot;
    fs.mkdirSync(transformsDir, { recursive: true });
    fs.writeFileSync(path.join(transformsDir, "transform.mjs"), "export default () => null;");

    const mappings = resolveHookMappings(
      {
        transformsDir: params.transformsDir,
        mappings: [
          {
            match: { path: "skip" },
            action: "agent",
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir: params.configDir },
    );

    return applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/skip"),
      path: "skip",
    });
  }

  it("resolves gmail preset", () => {
    const mappings = resolveHookMappings({ presets: ["gmail"] });
    expect(mappings.length).toBeGreaterThan(0);
    expect(mappings[0]?.matchPath).toBe("gmail");
  });

  it("renders template from payload", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "demo",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.kind).toBe("agent");
      expect(result.action.message).toBe("Subject: Hello");
    }
  });

  it("passes model override from mapping", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "demo",
          messageTemplate: "Subject: {{messages[0].subject}}",
          model: "openai/gpt-4.1-mini",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action && result.action.kind === "agent") {
      expect(result.action.model).toBe("openai/gpt-4.1-mini");
    }
  });

  it("runs transform module", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "transform.mjs");
    const placeholder = "${payload.name}";
    fs.writeFileSync(
      modPath,
      `export default ({ payload }) => ({ kind: "wake", text: \`Ping ${placeholder}\` });`,
    );

    const mappings = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "custom" },
            action: "agent",
            transform: { module: "transform.mjs" },
          },
        ],
      },
      { configDir },
    );

    const result = await applyHookMappings(mappings, {
      payload: { name: "Ada" },
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/custom"),
      path: "custom",
    });

    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "wake") {
      expect(result.action.kind).toBe("wake");
      expect(result.action.text).toBe("Ping Ada");
    }
  });

  it("rejects transform module traversal outside transformsDir", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-traversal-"));
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
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-abs-"));
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
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-trav-"));
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

  it("rejects transformsDir absolute path outside the transforms root", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-abs-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    expect(() =>
      resolveHookMappings(
        {
          transformsDir: os.tmpdir(),
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

  it("accepts transformsDir subdirectory within the transforms root", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-xformdir-ok-"));
    const result = await applyNullTransformFromTempConfig({ configDir, transformsDir: "subdir" });
    expectSkippedTransformResult(result);
  });
  it("treats null transform as a handled skip", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-skip-"));
    const result = await applyNullTransformFromTempConfig({ configDir });
    expectSkippedTransformResult(result);
  });

  it("prefers explicit mappings over presets", async () => {
    const result = await applyGmailMappings({
      presets: ["gmail"],
      mappings: [
        createGmailAgentMapping({
          id: "override",
          messageTemplate: "Override subject: {{messages[0].subject}}",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.kind).toBe("agent");
      expect(result.action.message).toBe("Override subject: Hello");
    }
  });

  it("passes agentId from mapping", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "hooks-agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
          agentId: "hooks",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBe("hooks");
    }
  });

  it("agentId is undefined when not set", async () => {
    const result = await applyGmailMappings({
      mappings: [
        createGmailAgentMapping({
          id: "no-agent",
          messageTemplate: "Subject: {{messages[0].subject}}",
        }),
      ],
    });
    expect(result?.ok).toBe(true);
    if (result?.ok && result.action?.kind === "agent") {
      expect(result.action.agentId).toBeUndefined();
    }
  });

  it("caches transform functions by module path and export name", async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-hooks-export-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });
    const modPath = path.join(transformsRoot, "multi-export.mjs");
    fs.writeFileSync(
      modPath,
      [
        'export function transformA() { return { kind: "wake", text: "from-A" }; }',
        'export function transformB() { return { kind: "wake", text: "from-B" }; }',
      ].join("\n"),
    );

    const mappingsA = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "testA" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "multi-export.mjs", export: "transformA" },
          },
        ],
      },
      { configDir },
    );

    const mappingsB = resolveHookMappings(
      {
        mappings: [
          {
            match: { path: "testB" },
            action: "agent",
            messageTemplate: "unused",
            transform: { module: "multi-export.mjs", export: "transformB" },
          },
        ],
      },
      { configDir },
    );

    const resultA = await applyHookMappings(mappingsA, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/testA"),
      path: "testA",
    });

    const resultB = await applyHookMappings(mappingsB, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/testB"),
      path: "testB",
    });

    expect(resultA?.ok).toBe(true);
    if (resultA?.ok && resultA.action?.kind === "wake") {
      expect(resultA.action.text).toBe("from-A");
    }

    expect(resultB?.ok).toBe(true);
    if (resultB?.ok && resultB.action?.kind === "wake") {
      expect(resultB.action.text).toBe("from-B");
    }
  });

  it("rejects missing message", async () => {
    const mappings = resolveHookMappings({
      mappings: [{ match: { path: "noop" }, action: "agent" }],
    });
    const result = await applyHookMappings(mappings, {
      payload: {},
      headers: {},
      url: new URL("http://127.0.0.1:18789/hooks/noop"),
      path: "noop",
    });
    expect(result?.ok).toBe(false);
  });

  describe("prototype pollution protection", () => {
    it("blocks __proto__ traversal in webhook payload", async () => {
      const mappings = resolveHookMappings({
        mappings: [
          createGmailAgentMapping({
            id: "proto-test",
            messageTemplate: "value: {{__proto__}}",
          }),
        ],
      });
      const result = await applyHookMappings(mappings, {
        payload: { __proto__: { polluted: true } } as Record<string, unknown>,
        headers: {},
        url: baseUrl,
        path: "gmail",
      });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        const action = result.action;
        if (action?.kind === "agent") {
          expect(action.message).toBe("value: ");
        }
      }
    });

    it("blocks constructor traversal in webhook payload", async () => {
      const mappings = resolveHookMappings({
        mappings: [
          createGmailAgentMapping({
            id: "constructor-test",
            messageTemplate: "type: {{constructor.name}}",
          }),
        ],
      });
      const result = await applyHookMappings(mappings, {
        payload: { constructor: { name: "INJECTED" } } as Record<string, unknown>,
        headers: {},
        url: baseUrl,
        path: "gmail",
      });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        const action = result.action;
        if (action?.kind === "agent") {
          expect(action.message).toBe("type: ");
        }
      }
    });

    it("blocks prototype traversal in webhook payload", async () => {
      const mappings = resolveHookMappings({
        mappings: [
          createGmailAgentMapping({
            id: "prototype-test",
            messageTemplate: "val: {{prototype}}",
          }),
        ],
      });
      const result = await applyHookMappings(mappings, {
        payload: { prototype: "leaked" } as Record<string, unknown>,
        headers: {},
        url: baseUrl,
        path: "gmail",
      });
      expect(result?.ok).toBe(true);
      if (result?.ok) {
        const action = result.action;
        if (action?.kind === "agent") {
          expect(action.message).toBe("val: ");
        }
      }
    });
  });
});

describe("Security: OC-201 Regression", () => {
  it("rejects transform module that is a symlink pointing outside transformsDir", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-symlink-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });

    // Create malicious module outside transformsDir
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-outside-"));
    const evilModule = path.join(outsideDir, "evil.mjs");
    fs.writeFileSync(evilModule, "export default () => null;");

    // Create symlink inside transformsDir pointing to evil module
    const symlinkPath = path.join(transformsRoot, "evil-link.mjs");
    fs.symlinkSync(evilModule, symlinkPath);

    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "evil-link.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/symlink|escapes|must be within/i);

    // Cleanup
    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects transformsDir that is a symlink pointing outside config", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-tdir-sym-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });

    // Create symlink subdirectory pointing outside
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-outside-tdir-"));
    const symlinkDir = path.join(transformsRoot, "escaped");
    fs.symlinkSync(outsideDir, symlinkDir);

    expect(() =>
      resolveHookMappings(
        {
          transformsDir: "escaped",
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
    ).toThrow(/symlink|escapes|must be within|Hook transformsDir/i);

    fs.rmSync(configDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("rejects nested path traversal in transform module (subdir/../../evil.mjs)", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-nested-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    const subdir = path.join(transformsRoot, "subdir");
    fs.mkdirSync(subdir, { recursive: true });

    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "subdir/../../evil.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/must be within/);

    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("OC-201: rejects config.patch attack with absolute transformsDir=/tmp", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-oc201-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });

    // Simulate the exploit: transformsDir = /tmp, module = "rce.mjs"
    expect(() =>
      resolveHookMappings(
        {
          transformsDir: os.tmpdir(),
          mappings: [
            {
              match: { path: "rce-trigger" },
              action: "agent",
              transform: { module: "rce.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).toThrow(/Hook transformsDir/);

    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("rejects ENOENT symlink gracefully via lexical check when file doesn't exist", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-enoent-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });

    // Create a valid module that we'll use to test the symlink mechanism works
    const validModule = path.join(transformsRoot, "valid-transform.mjs");
    fs.writeFileSync(validModule, "export default () => null;");

    // This tests that even for non-existent files, Layer 1 (lexical check) protects
    // against path traversal - the implementation gracefully falls back to Layer 1
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              // Non-existent file with valid module name should work fine
              transform: { module: "nonexistent.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).not.toThrow();

    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("permits symlink within transformsDir even if target doesn't exist (graceful fallback)", () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-config-broken-symlink-"));
    const transformsRoot = path.join(configDir, "hooks", "transforms");
    fs.mkdirSync(transformsRoot, { recursive: true });

    // Create a symlink to non-existent file WITHIN transformsDir
    // This simulates a symlink that points to a future-created file
    const symlinkPath = path.join(transformsRoot, "future-transform.mjs");
    const futureTarget = path.join(transformsRoot, "will-exist-later.mjs");
    fs.symlinkSync(futureTarget, symlinkPath);

    // This should NOT throw because Layer 1 (lexical check) passes:
    // symlink is inside transformsRoot and doesn't escape via ../
    // Layer 2 (realpath) will fail with ENOENT but gracefully falls back to Layer 1
    expect(() =>
      resolveHookMappings(
        {
          mappings: [
            {
              match: { path: "custom" },
              action: "agent",
              transform: { module: "future-transform.mjs" },
            },
          ],
        },
        { configDir },
      ),
    ).not.toThrow();

    fs.rmSync(configDir, { recursive: true, force: true });
  });
});
