// Protocol schema artifact tests cover the published document contract.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertProtocolSchemaDocument,
  buildProtocolSchemaDocument,
  type ProtocolSchemaDocument,
} from "../../scripts/lib/protocol-schema-document.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function buildValidDocument(): ProtocolSchemaDocument {
  return buildProtocolSchemaDocument({
    methods: [{ name: "health", scope: "operator.read", since: "<=2026.7" }],
    schemas: {
      ConnectParams: { type: "object" },
      RequestFrame: { type: "object" },
      ResponseFrame: { type: "object" },
      EventFrame: { type: "object" },
    },
  });
}

describe("published protocol schema document", () => {
  it("rejects a document that lost a required frame definition", () => {
    const document = buildValidDocument();
    delete document.definitions.ConnectParams;

    expect(() => assertProtocolSchemaDocument(document)).toThrow(
      "definition ConnectParams is missing",
    );
  });

  it("rejects reordered frame branches", () => {
    const document = buildValidDocument();
    document.oneOf = document.oneOf.toReversed();

    expect(() => assertProtocolSchemaDocument(document)).toThrow("frame oneOf must list");
  });

  it("rejects a rewritten type discriminator", () => {
    const document = buildValidDocument();
    document.discriminator.mapping.req = "#/definitions/EventFrame";

    expect(() => assertProtocolSchemaDocument(document)).toThrow("type discriminator must map");
  });

  it("rejects an empty method catalog", () => {
    const document = buildValidDocument();
    document.methods = {};

    expect(() => assertProtocolSchemaDocument(document)).toThrow("method metadata is empty");
  });
});

describe("protocol-gen artifact", () => {
  it("writes the canonical document the contract check guards", () => {
    const outputPath = path.join(tempDirs.make("openclaw-protocol-gen-"), "protocol.schema.json");
    execFileSync(
      process.execPath,
      ["--import", "./scripts/tsx.mjs", "scripts/protocol-gen.ts", "--out", outputPath],
      { cwd: repoRoot, encoding: "utf8", stdio: "pipe" },
    );

    const written = fs.readFileSync(outputPath, "utf8");
    const document = JSON.parse(written) as ProtocolSchemaDocument;
    expect(() => assertProtocolSchemaDocument(document)).not.toThrow();
    // Rebuilding the envelope from the artifact's own parts fails the moment
    // the generator stops emitting exactly what the shared owner produces.
    expect(
      JSON.stringify(
        buildProtocolSchemaDocument({
          methods: Object.entries(document.methods).map(([name, metadata]) =>
            Object.assign({ name }, metadata),
          ),
          schemas: document.definitions,
        }),
        null,
        2,
      ),
    ).toBe(written);
  }, 120_000);
});
