import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { SecretsConfigSchema } from "../../config/zod-schema.core.js";
import { ensureSecretEgressProxyCa, generateLocalProxyLeaf } from "../../proxy-capture/ca.js";
import { loadUpstreamCaFiles } from "./upstream-ca.js";

const dirs = useAutoCleanupTempDirTracker(afterAll);
let dir: string;
let caPem: string;
let leafPem: string;
beforeAll(async () => {
  dir = dirs.make("openclaw-upstream-ca-");
  const ca = await ensureSecretEgressProxyCa(dir);
  caPem = fs.readFileSync(ca.certPath, "utf8");
  leafPem = (
    await generateLocalProxyLeaf({ certDir: dir, ca, hostname: "localhost" })
  ).cert.toString();
});

function file(name: string, contents: string): string {
  const target = path.join(dir, name);
  fs.writeFileSync(target, contents);
  return target;
}

describe("explicit upstream CA admission", () => {
  it("preserves the default and admits certificate-only bundles", () => {
    expect(loadUpstreamCaFiles()).toEqual([]);
    expect(loadUpstreamCaFiles([file("bundle.pem", `${caPem}\n${caPem}`)])).toHaveLength(2);
  });
  it.each(["missing", "empty", "malformed", "leaf", "key", "oversized", "relative"])(
    "rejects %s input without echoing file contents",
    (kind) => {
      const contents: Readonly<Record<string, string>> = {
        empty: "",
        malformed: "-----BEGIN CERTIFICATE-----\nnot-base64\n-----END CERTIFICATE-----",
        leaf: leafPem,
        key: `${caPem}\n-----BEGIN PRIVATE KEY-----\nPRIVATE-MARKER\n-----END PRIVATE KEY-----`,
        oversized: `${caPem}${" ".repeat(1024 * 1024)}`,
      };
      const content = contents[kind];
      const target =
        kind === "relative"
          ? "relative.pem"
          : content === undefined
            ? path.join(dir, "missing.pem")
            : file(`${kind}.pem`, content);
      expect(() => loadUpstreamCaFiles([target])).toThrow("upstreamCaFiles[0]");
      try {
        loadUpstreamCaFiles([target]);
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE-MARKER");
      }
    },
  );
  it("rejects non-regular files before reading", () => {
    expect(() => loadUpstreamCaFiles([dir])).toThrow("upstreamCaFiles[0]");
  });
  it("validates paths and bounds at the configuration boundary", () => {
    expect(
      SecretsConfigSchema.safeParse({
        egressProxy: { upstreamCaFiles: [path.join(dir, "ca.pem")] },
      }).success,
    ).toBe(true);
    for (const upstreamCaFiles of [[""], ["relative.pem"], Array(17).fill("/ca.pem"), "invalid"]) {
      expect(SecretsConfigSchema.safeParse({ egressProxy: { upstreamCaFiles } }).success).toBe(
        false,
      );
    }
  });
});
