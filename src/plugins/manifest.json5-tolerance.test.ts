// Covers JSON5 tolerance in plugin manifest parsing.
import fs from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPluginManifestLoadCache,
  loadPluginManifest,
  MAX_PLUGIN_MANIFEST_BYTES,
} from "./manifest.js";
import { cleanupTrackedTempDirs, makeTrackedTempDir } from "./test-helpers/fs-fixtures.js";

const tempDirs: string[] = [];

function makeTempDir() {
  return makeTrackedTempDir("openclaw-manifest-json5", tempDirs);
}

afterEach(() => {
  vi.restoreAllMocks();
  clearPluginManifestLoadCache();
  cleanupTrackedTempDirs(tempDirs);
});

describe("loadPluginManifest JSON5 tolerance", () => {
  it("parses a standard JSON manifest without issues", () => {
    const dir = makeTempDir();
    const manifest = {
      id: "demo",
      configSchema: { type: "object" },
    };
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("demo");
    }
  });

  it("uses native JSON parsing for standard JSON manifests", () => {
    const json5Parse = vi.spyOn(JSON5, "parse");
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "strict-json",
        configSchema: { type: "object" },
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    expect(json5Parse).not.toHaveBeenCalled();
  });

  it("reuses unchanged manifest loads by file signature", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "cached-json",
        configSchema: { type: "object" },
      }),
      "utf-8",
    );
    const readFileSync = vi.spyOn(fs, "readFileSync");

    const first = loadPluginManifest(dir, false);
    const second = loadPluginManifest(dir, false);

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(readFileSync).toHaveBeenCalledTimes(1);
  });

  it("parses a manifest with trailing commas", () => {
    const dir = makeTempDir();
    const json5Content = `{
  "id": "hindsight",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string" },
    },
  },
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("hindsight");
    }
  });

  it("parses a manifest with single-line comments", () => {
    const dir = makeTempDir();
    const json5Content = `{
  // Plugin identifier
  "id": "commented-plugin",
  "configSchema": { "type": "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("commented-plugin");
    }
  });

  it("parses a manifest with unquoted property names", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "unquoted-keys",
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe("unquoted-keys");
    }
  });

  it("normalizes modelSupport metadata from the manifest", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "provider-plugin",
  modelSupport: {
    modelPrefixes: ["gpt-", "", "claude-"],
    modelPatterns: ["^o[0-9].*", ""],
  },
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.modelSupport).toEqual({
        modelPrefixes: ["gpt-", "claude-"],
        modelPatterns: ["^o[0-9].*"],
      });
    }
  });

  it("normalizes activation and setup descriptor metadata from the manifest", () => {
    const dir = makeTempDir();
    const json5Content = `{
  id: "openai",
  activation: {
    onStartup: false,
    onProviders: ["openai", "", "openai"],
    onCommands: ["models", ""],
    onChannels: ["web", ""],
    onRoutes: ["gateway-webhook", ""],
    onConfigPaths: ["browser", ""],
    onCapabilities: ["provider", "tool", "wat"]
  },
  setup: {
    providers: [
      { id: "openai", authMethods: ["api-key", ""], envVars: ["OPENAI_API_KEY", ""] },
      { id: "", authMethods: ["oauth"] }
    ],
    cliBackends: ["openai-cli", ""],
    configMigrations: ["legacy-openai-auth", ""],
    requiresRuntime: false
  },
  configSchema: { type: "object" }
}`;
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), json5Content, "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.activation).toEqual({
        onStartup: false,
        onProviders: ["openai", "openai"],
        onCommands: ["models"],
        onChannels: ["web"],
        onRoutes: ["gateway-webhook"],
        onConfigPaths: ["browser"],
        onCapabilities: ["provider", "tool"],
      });
      expect(result.manifest.setup).toEqual({
        providers: [
          {
            id: "openai",
            authMethods: ["api-key"],
            envVars: ["OPENAI_API_KEY"],
          },
        ],
        cliBackends: ["openai-cli"],
        configMigrations: ["legacy-openai-auth"],
        requiresRuntime: false,
      });
    }
  });

  it("normalizes bounded credential broker operations", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "brokered-plugin",
        contracts: { tools: ["brokered_action"] },
        configContracts: {
          secretInputs: { paths: [{ path: "service.token", expected: "string" }] },
        },
        credentialBroker: {
          operations: [
            {
              id: "action",
              tool: "brokered_action",
              secretInputPath: "service.token",
              baseUrlConfigPath: "service.baseUrl",
              baseUrlEnv: "SERVICE_BASE_URL",
              defaultBaseUrl: "https://api.example.test/v1",
              path: "/action",
              method: "POST",
              credentialHeader: "authorization",
              credentialScheme: "Bearer",
              headers: {
                "X-Client-Source": "openclaw",
              },
              maxRequestBodyBytes: 4096,
              maxResponseBodyBytes: 8192,
              timeoutMs: 5000,
            },
          ],
        },
        configSchema: { type: "object" },
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.credentialBroker).toEqual({
        operations: [
          {
            id: "action",
            tool: "brokered_action",
            secretInputPath: "service.token",
            baseUrlConfigPath: "service.baseUrl",
            baseUrlEnv: "SERVICE_BASE_URL",
            defaultBaseUrl: "https://api.example.test/v1",
            path: "/action",
            method: "POST",
            credentialHeader: "Authorization",
            credentialScheme: "Bearer",
            headers: { "X-Client-Source": "openclaw" },
            maxRequestBodyBytes: 4096,
            maxResponseBodyBytes: 8192,
            timeoutMs: 5000,
          },
        ],
      });
    }
  });

  it("rejects the manifest when any credential broker operation is unsafe", () => {
    const dir = makeTempDir();
    const operation = {
      id: "action",
      tool: "brokered_action",
      secretInputPath: "service.token",
      defaultBaseUrl: "https://api.example.test",
      path: "/action",
      method: "POST",
      credentialHeader: "Authorization",
      maxRequestBodyBytes: 4096,
      maxResponseBodyBytes: 8192,
      timeoutMs: 5000,
    };
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "unsafe-brokered-plugin",
        contracts: { tools: ["brokered_action"] },
        configContracts: {
          secretInputs: { paths: [{ path: "service.token", expected: "string" }] },
        },
        credentialBroker: {
          operations: [
            operation,
            { ...operation, id: "insecure", defaultBaseUrl: "http://api.example.test" },
            { ...operation, id: "read", method: "GET" },
            { ...operation, id: "cookie", credentialHeader: "Cookie" },
            { ...operation, id: "traversal", secretInputPath: "service..token" },
            { ...operation, id: "environment", baseUrlEnv: "unsafe-env-name" },
            { ...operation, id: "header", headers: { Authorization: "static-secret" } },
            {
              ...operation,
              id: "routing-header",
              headers: { "X-Original-URL": "/admin" },
            },
            {
              ...operation,
              id: "method-header",
              headers: { "X-HTTP-Method-Override": "GET" },
            },
          ],
        },
        configSchema: { type: "object" },
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe("plugin manifest credentialBroker is invalid");
    }
  });

  it("still rejects completely invalid syntax", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "not json at all {{{}}", "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to parse plugin manifest");
    }
  });

  it("rejects JSON5 values that parse but are not objects", () => {
    const dir = makeTempDir();
    fs.writeFileSync(path.join(dir, "openclaw.plugin.json"), "'just a string'", "utf-8");
    const result = loadPluginManifest(dir, false);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("plugin manifest must be an object");
    }
  });

  it("rejects oversized manifests before parsing", () => {
    const dir = makeTempDir();
    fs.writeFileSync(
      path.join(dir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "too-large",
        configSchema: { type: "object" },
        padding: "x".repeat(MAX_PLUGIN_MANIFEST_BYTES),
      }),
      "utf-8",
    );

    const result = loadPluginManifest(dir, false);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("unsafe plugin manifest path");
    }
  });
});
