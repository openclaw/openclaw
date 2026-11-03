import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBlockedPluginDiagnosticLookup } from "./discovery-availability.js";
import type { PluginDiagnostic } from "./manifest-types.js";

describe("blocked plugin diagnostic attribution", () => {
  it("prefers normalized explicit ids and never attributes their source to another plugin", () => {
    const diagnostic: PluginDiagnostic = {
      level: "warn",
      pluginId: " Actual-ID ",
      source: path.resolve("plugins", "alias-dir", "index.js"),
      message: "blocked plugin candidate: suspicious ownership",
    };
    const legacy: PluginDiagnostic = {
      level: "warn",
      source: path.resolve("plugins", "actual-id", "index.js"),
      message: "blocked plugin candidate: world-writable path",
    };
    const lookup = createBlockedPluginDiagnosticLookup({
      diagnostics: [legacy, diagnostic],
      config: { plugins: { load: { paths: [path.resolve("plugins", "alias-dir")] } } },
    });
    expect(lookup("ACTUAL-ID")).toMatchObject({
      message: diagnostic.message,
      source: diagnostic.source,
    });
    expect(lookup(" actual-id ")).toMatchObject({ message: diagnostic.message });
    expect(lookup("alias-dir")).toBeUndefined();
    expect(lookup("unrelated")).toBeUndefined();
  });

  it("retains legacy plugin-id alias normalization", () => {
    const lookup = createBlockedPluginDiagnosticLookup({
      diagnostics: [
        {
          level: "warn",
          pluginId: " GOOGLE-GEMINI-CLI ",
          message: "blocked plugin candidate: suspicious ownership",
        },
      ],
    });
    expect(lookup("google")).toMatchObject({
      message: "blocked plugin candidate: suspicious ownership",
    });
    expect(lookup("google-gemini-cli")).toBeDefined();
  });

  it("matches ID-less sources through basenames and normalized configured load paths", () => {
    const home = path.resolve("fixture-home");
    const lookup = createBlockedPluginDiagnosticLookup({
      env: { HOME: home, USERPROFILE: home, OPENCLAW_HOME: home },
      config: { plugins: { load: { paths: [" ~/plugins/load-owner/ "] } } },
      diagnostics: [
        {
          level: "warn",
          source: " ~/plugins/load-owner/dist/nested/index.js ",
          message: "blocked plugin candidate: suspicious ownership",
        },
        {
          level: "warn",
          source: path.join(home, "plugins", "parent-owner", "index.js"),
          message: "blocked plugin candidate: world-writable path",
        },
        {
          level: "warn",
          source: path.join(home, "plugins", "directory-owner"),
          message: "blocked plugin candidate: cannot stat path",
        },
      ],
    });
    expect(lookup(" LOAD-OWNER ")).toBeDefined();
    expect(lookup("parent-owner")).toBeDefined();
    expect(lookup("directory-owner")).toBeDefined();
    expect(lookup("unrelated")).toBeUndefined();
  });

  it("does not treat non-block warnings or sibling path prefixes as blocked owners", () => {
    const lookup = createBlockedPluginDiagnosticLookup({
      config: { plugins: { load: { paths: [path.resolve("plugins", "owner")] } } },
      diagnostics: [
        {
          level: "warn",
          pluginId: "ordinary-warning",
          message: "plugin metadata warning",
        },
        {
          level: "warn",
          source: path.resolve("plugins", "owner-other", "dist", "index.js"),
          message: "blocked plugin candidate: suspicious ownership",
        },
      ],
    });
    expect(lookup("ordinary-warning")).toBeUndefined();
    expect(lookup("owner")).toBeUndefined();
  });
});
