import { describe, expect, it } from "vitest";
import {
  parseSkillFrontmatter,
  resolveSkillManifestMetadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";

it("rejects unresolved aliases under explicit YAML keys", () => {
  expect(() =>
    parseSkillFrontmatter(`---
name: sample-skill
description: Working skill
? metadata
: *missing
---`),
  ).toThrow(/invalid frontmatter.*YAML_EXCEPTION: Unresolved alias/);
});

describe("resolveSkillManifestMetadata install validation", () => {
  function resolveInstall(...install: unknown[]) {
    return resolveSkillManifestMetadata({ metadata: JSON.stringify({ openclaw: { install } }) })
      ?.install;
  }

  it("accepts safe install specs", () => {
    const install = resolveInstall(
      { kind: "brew", formula: "python@3.12" },
      { kind: "node", package: "@scope/pkg@1.2.3" },
      { kind: "go", module: "example.com/tool/cmd@v1.2.3" },
      { kind: "uv", package: "uvicorn[standard]==0.31.0" },
      { kind: "download", url: "https://example.com/tool.tar.gz" },
    );
    expect(install).toEqual([
      { kind: "brew", formula: "python@3.12" },
      { kind: "node", package: "@scope/pkg@1.2.3" },
      { kind: "go", module: "example.com/tool/cmd@v1.2.3" },
      { kind: "uv", package: "uvicorn[standard]==0.31.0" },
      { kind: "download", url: "https://example.com/tool.tar.gz" },
    ]);
  });

  it.each([
    { kind: "brew", formula: "wget --HEAD" },
    { kind: "node", package: "file:../malicious" },
    { kind: "go", module: "https://evil.example/mod" },
    { kind: "download", url: "file:///tmp/payload.tgz" },
  ])("drops unsafe $kind install specs", (spec) => {
    expect(resolveInstall(spec)).toBeUndefined();
  });

  it("normalizes a download installer's optional SHA-256 digest", () => {
    const sha256 = "a".repeat(64);
    const install = resolveInstall({
      kind: "download",
      url: "https://example.com/runtime.tar.bz2",
      sha256: ` ${sha256.toUpperCase()} `,
    });

    expect(install).toEqual([
      { kind: "download", url: "https://example.com/runtime.tar.bz2", sha256 },
    ]);
  });

  it.each(["g".repeat(64), 123])(
    "drops a download installer declaring an invalid SHA-256 digest (%j)",
    (sha256) => {
      const install = resolveInstall({
        kind: "download",
        url: "https://example.com/runtime.tar.bz2",
        sha256,
      });

      expect(install).toBeUndefined();
    },
  );

  it("parses Link-style YAML metadata with node install hints", () => {
    const frontmatter = parseSkillFrontmatter(`---
name: create-payment-credential
description: |
  Gets one-time-use payment credentials.
metadata:
  openclaw:
    homepage: https://link.com/agents
    requires:
      bins:
        - link-cli
    install:
      - kind: node
        package: "@stripe/link-cli"
        bins: [link-cli]
user-invocable: true
---
`);

    const metadata = resolveSkillManifestMetadata(frontmatter);

    expect(frontmatter).toMatchObject({
      name: "create-payment-credential",
      description: expect.stringContaining("one-time-use payment credentials"),
    });
    expect(resolveSkillInvocationPolicy(frontmatter).userInvocable).toBe(true);
    expect(metadata).toEqual({
      homepage: "https://link.com/agents",
      requires: { bins: ["link-cli"], anyBins: [], env: [], config: [] },
      install: [{ kind: "node", package: "@stripe/link-cli", bins: ["link-cli"] }],
    });
  });
});
