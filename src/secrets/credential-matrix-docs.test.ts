import { describe, expect, it } from "vitest";
import {
  formatSecretRefSupportedListMarkdown,
  formatSecretRefUnsupportedListMarkdown,
  replaceMarkedBlock,
} from "./credential-matrix-docs.js";
import type { SecretRefCredentialMatrixDocument } from "./credential-matrix.js";

function buildFixture(
  overrides: Partial<SecretRefCredentialMatrixDocument> = {},
): SecretRefCredentialMatrixDocument {
  return {
    version: 1,
    matrixId: "strictly-user-supplied-credentials",
    pathSyntax: 'Dot path with "*" for map keys and "[]" for arrays.',
    scope:
      "Credentials that are strictly user-supplied and not minted/rotated by OpenClaw runtime.",
    excludedMutableOrRuntimeManaged: [],
    entries: [],
    ...overrides,
  };
}

describe("formatSecretRefSupportedListMarkdown", () => {
  it("emits openclaw.json entries as plain backticked path lines, sorted by id", () => {
    const matrix = buildFixture({
      entries: [
        {
          id: "models.providers.*.apiKey",
          configFile: "openclaw.json",
          path: "models.providers.*.apiKey",
          secretShape: "secret_input",
          optIn: true,
        },
        {
          id: "channels.discord.token",
          configFile: "openclaw.json",
          path: "channels.discord.token",
          secretShape: "secret_input",
          optIn: true,
        },
      ],
    });
    const md = formatSecretRefSupportedListMarkdown(matrix);
    expect(md.startsWith("\n\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(true);
    const order = md.split("\n").filter((line) => line.startsWith("- "));
    expect(order).toEqual(["- `channels.discord.token`", "- `models.providers.*.apiKey`"]);
  });

  it("renders sibling_ref openclaw entries with the compatibility-exception suffix", () => {
    const matrix = buildFixture({
      entries: [
        {
          id: "channels.googlechat.serviceAccount",
          configFile: "openclaw.json",
          path: "channels.googlechat.serviceAccount",
          refPath: "channels.googlechat.serviceAccountRef",
          secretShape: "sibling_ref",
          optIn: true,
          notes: "Compatibility exception: sibling ref field remains canonical.",
        },
      ],
    });
    const md = formatSecretRefSupportedListMarkdown(matrix);
    expect(md).toContain(
      "- `channels.googlechat.serviceAccount` via sibling `serviceAccountRef` (compatibility exception)",
    );
  });

  it("emits a separate auth-profiles.json subsection with type+oauth annotation", () => {
    const matrix = buildFixture({
      entries: [
        {
          id: "auth-profiles.api_key.key",
          configFile: "auth-profiles.json",
          path: "profiles.*.key",
          refPath: "profiles.*.keyRef",
          when: { type: "api_key" },
          secretShape: "sibling_ref",
          optIn: true,
        },
        {
          id: "auth-profiles.token.token",
          configFile: "auth-profiles.json",
          path: "profiles.*.token",
          refPath: "profiles.*.tokenRef",
          when: { type: "token" },
          secretShape: "sibling_ref",
          optIn: true,
        },
      ],
    });
    const md = formatSecretRefSupportedListMarkdown(matrix);
    expect(md).toContain(
      "### `auth-profiles.json` targets (`secrets configure` + `secrets apply` + `secrets audit`)",
    );
    expect(md).toContain(
      '- `profiles.*.keyRef` (`type: "api_key"`; unsupported when `auth.profiles.<id>.mode = "oauth"`)',
    );
    expect(md).toContain(
      '- `profiles.*.tokenRef` (`type: "token"`; unsupported when `auth.profiles.<id>.mode = "oauth"`)',
    );
  });

  it("omits the auth-profiles subsection when no auth-profile entries exist", () => {
    const matrix = buildFixture({
      entries: [
        {
          id: "models.providers.*.apiKey",
          configFile: "openclaw.json",
          path: "models.providers.*.apiKey",
          secretShape: "secret_input",
          optIn: true,
        },
      ],
    });
    const md = formatSecretRefSupportedListMarkdown(matrix);
    expect(md).not.toContain("auth-profiles.json");
  });
});

describe("formatSecretRefUnsupportedListMarkdown", () => {
  it("emits excluded patterns in registry order with surrounding blank lines", () => {
    const matrix = buildFixture({
      excludedMutableOrRuntimeManaged: ["hooks.token", "auth-profiles.oauth.*"],
    });
    const md = formatSecretRefUnsupportedListMarkdown(matrix);
    expect(md.startsWith("\n\n")).toBe(true);
    expect(md.endsWith("\n\n")).toBe(true);
    const order = md.split("\n").filter((line) => line.startsWith("- "));
    expect(order).toEqual(["- `hooks.token`", "- `auth-profiles.oauth.*`"]);
  });

  it("produces an empty body with only blank-line padding when nothing is excluded", () => {
    const matrix = buildFixture({ excludedMutableOrRuntimeManaged: [] });
    const md = formatSecretRefUnsupportedListMarkdown(matrix);
    expect(md.split("\n").filter((line) => line.startsWith("- "))).toEqual([]);
  });
});

describe("replaceMarkedBlock", () => {
  const start = '[//]: # "secretref-test-start"';
  const end = '[//]: # "secretref-test-end"';

  it("replaces the body strictly between the markers and preserves them", () => {
    const source = `prologue\n${start}\nstale-1\nstale-2\n${end}\nepilogue`;
    const next = replaceMarkedBlock(source, {
      startMarker: start,
      endMarker: end,
      body: "\n\n- one\n- two\n\n",
    });
    expect(next).toBe(`prologue\n${start}\n\n- one\n- two\n\n${end}\nepilogue`);
  });

  it("is idempotent when applied twice with the same body", () => {
    const source = `${start}\n\n- a\n\n${end}`;
    const once = replaceMarkedBlock(source, {
      startMarker: start,
      endMarker: end,
      body: "\n\n- a\n\n",
    });
    const twice = replaceMarkedBlock(once, {
      startMarker: start,
      endMarker: end,
      body: "\n\n- a\n\n",
    });
    expect(twice).toBe(once);
  });

  it("throws when the start marker is missing", () => {
    expect(() =>
      replaceMarkedBlock("no markers here", {
        startMarker: start,
        endMarker: end,
        body: "x",
      }),
    ).toThrow(/start marker not found/);
  });

  it("throws when the end marker is missing after the start marker", () => {
    expect(() =>
      replaceMarkedBlock(`prefix ${start} no closing`, {
        startMarker: start,
        endMarker: end,
        body: "x",
      }),
    ).toThrow(/end marker not found/);
  });
});
