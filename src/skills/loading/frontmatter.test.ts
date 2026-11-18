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
  const download = (sha256: unknown) => ({
    kind: "download",
    url: "https://example.com/runtime.tar.bz2",
    sha256,
  });

  const targets: Array<[kind: string, field: string, safe: string, unsafe?: string]> = [
    ["brew", "formula", "python@3.12", "wget --HEAD"],
    ["node", "package", "@scope/pkg@1.2.3", "file:../malicious"],
    ["go", "module", "example.com/tool/cmd@v1.2.3", "https://evil.example/mod"],
    ["uv", "package", "uvicorn[standard]==0.31.0"],
    ["download", "url", "https://example.com/tool.tar.gz", "file:///tmp/payload.tgz"],
  ];
  it("accepts all safe install specs together", () => {
    const specs = targets.map(([kind, field, safe]) => ({ kind, [field]: safe }));
    expect(resolveInstall(...specs)).toEqual(specs);
  });
  it.each(targets.filter((target) => target[3]))(
    "rejects unsafe %s targets",
    (kind, field, _safe, unsafe) => {
      expect(resolveInstall({ kind, [field]: unsafe })).toBeUndefined();
    },
  );

  it("normalizes a download installer's optional SHA-256 digest", () => {
    const sha256 = "a".repeat(64);
    expect(resolveInstall(download(` ${sha256.toUpperCase()} `))).toEqual([download(sha256)]);
  });

  it.each(["g".repeat(64), 123])(
    "drops a download installer declaring an invalid SHA-256 digest (%j)",
    (sha256) => {
      expect(resolveInstall(download(sha256))).toBeUndefined();
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
      bins: [link-cli]
    install:
      - kind: node
        package: "@stripe/link-cli"
        bins: [link-cli]
user-invocable: true
---
`);

    expect(frontmatter).toMatchObject({
      name: "create-payment-credential",
      description: expect.stringContaining("one-time-use payment credentials"),
    });
    expect(resolveSkillInvocationPolicy(frontmatter).userInvocable).toBe(true);
    expect(resolveSkillManifestMetadata(frontmatter)).toEqual({
      homepage: "https://link.com/agents",
      requires: { bins: ["link-cli"], anyBins: [], env: [], config: [] },
      install: [{ kind: "node", package: "@stripe/link-cli", bins: ["link-cli"] }],
    });
  });
});
